// Batch WooCommerce Sync v1 — processes pending_product_syncs queue
// Designed to run every minute via pg_cron. Groups by product, uses WC batch API.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooConfig {
  url: string;
  consumerKey: string;
  consumerSecret: string;
}

function normalizeSize(size: string): string {
  return size.toLowerCase().replace(/\s+/g, '').trim();
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
    try {
      const resp = await fetch(url, options);
      if (resp.status === 429) {
        const wait = parseInt(resp.headers.get('Retry-After') || '5') * 1000;
        console.log(`Rate limited, waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return resp;
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError || new Error('All retries failed');
}

function wooUrl(base: string, path: string, config: WooConfig): string {
  const u = new URL(`${base}/wp-json/wc/v3/${path}`);
  u.searchParams.set('consumer_key', config.consumerKey);
  u.searchParams.set('consumer_secret', config.consumerSecret);
  return u.toString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // ── 1. Fetch pending syncs (oldest first, max 50 products per run) ──
    const { data: pendingSyncs, error: fetchErr } = await supabase
      .from('pending_product_syncs')
      .select('product_id, tenant_id, reason, created_at')
      .order('created_at', { ascending: true })
      .limit(100);

    if (fetchErr) throw fetchErr;
    if (!pendingSyncs || pendingSyncs.length === 0) {
      return new Response(JSON.stringify({ message: 'No pending syncs', processed: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Group by tenant
    const byTenant = new Map<string, typeof pendingSyncs>();
    for (const sync of pendingSyncs) {
      const list = byTenant.get(sync.tenant_id) || [];
      list.push(sync);
      byTenant.set(sync.tenant_id, list);
    }

    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    const allResults: any[] = [];

    for (const [tenantId, syncs] of byTenant) {
      // ── 2. Load WooCommerce config ──
      const { data: tenantConfig } = await supabase
        .from('tenant_config')
        .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
        .eq('tenant_id', tenantId)
        .single();

      if (!tenantConfig) {
        console.error(`No WooCommerce config for tenant ${tenantId}`);
        continue;
      }

      const wooConfig: WooConfig = {
        url: tenantConfig.woocommerce_url,
        consumerKey: tenantConfig.woocommerce_consumer_key,
        consumerSecret: tenantConfig.woocommerce_consumer_secret,
      };

      // Deduplicate product IDs
      const productIds = [...new Set(syncs.map(s => s.product_id))];
      const reasons = [...new Set(syncs.map(s => s.reason))];

      // ── 3. Bulk fetch product data + variants + stock + prices ──
      const { data: products } = await supabase
        .from('products')
        .select(`
          id, sku,
          product_prices(regular, list),
          variants!variants_product_id_fkey(
            id, maat_id, size_label,
            stock_totals(qty)
          )
        `)
        .in('id', productIds);

      if (!products || products.length === 0) {
        // Clean up orphaned syncs
        await supabase.from('pending_product_syncs').delete().in('product_id', productIds);
        continue;
      }

      // ── 4. Process each product ──
      for (const product of products) {
        const productSku = product.sku;
        const syncReasons = syncs.filter(s => s.product_id === product.id).map(s => s.reason);

        try {
          // Find WooCommerce product
          const searchResp = await fetchWithRetry(
            wooUrl(wooConfig.url, `products?sku=${encodeURIComponent(productSku)}&per_page=1`, wooConfig),
            { headers: { 'Content-Type': 'application/json' } }
          );

          if (!searchResp.ok) {
            const text = await searchResp.text();
            if (text.includes('sgcapt') || text.includes('<html')) {
              console.error(`SiteGround bot protection blocking API for ${productSku}`);
              allResults.push({ sku: productSku, success: false, reason: 'SiteGround bot block' });
              totalFailed++;
              continue;
            }
            allResults.push({ sku: productSku, success: false, reason: `Search failed: ${searchResp.status}` });
            totalFailed++;
            continue;
          }

          let wooProducts;
          try { wooProducts = await searchResp.json(); } catch {
            allResults.push({ sku: productSku, success: false, reason: 'Invalid JSON from WooCommerce' });
            totalFailed++;
            continue;
          }

          if (!wooProducts?.length) {
            allResults.push({ sku: productSku, success: false, reason: 'Not found in WooCommerce' });
            totalFailed++;
            continue;
          }

          const wooProductId = wooProducts[0].id;
          const variants = (product.variants as any[]) || [];
          const priceData = product.product_prices as any;
          const price = Array.isArray(priceData) ? priceData[0] : priceData;

          // ── 4a. Stock updates via batch API ──
          if (syncReasons.includes('stock') && variants.length > 0) {
            // Fetch WooCommerce variations
            const varResp = await fetchWithRetry(
              wooUrl(wooConfig.url, `products/${wooProductId}/variations?per_page=100`, wooConfig),
              { headers: { 'Content-Type': 'application/json' } }
            );

            if (varResp.ok) {
              const wooVariations = await varResp.json();
              const updates: any[] = [];

              for (const variant of variants) {
                const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
                const expectedSku = `${productSku}-${variant.maat_id}`;
                const legacySku = `${productSku}-${variant.size_label}`;

                // Find matching WC variation
                const match = wooVariations.find((wv: any) => {
                  if (!wv.sku) return false;
                  const norm = normalizeSize(wv.sku);
                  return norm === normalizeSize(expectedSku) ||
                         norm === normalizeSize(legacySku) ||
                         wv.sku.endsWith(variant.size_label);
                });

                if (match) {
                  // Only push if stock actually differs
                  if (match.stock_quantity !== stockQty) {
                    updates.push({
                      id: match.id,
                      stock_quantity: stockQty,
                      manage_stock: true,
                      stock_status: stockQty > 0 ? 'instock' : 'outofstock',
                    });
                  }
                }
              }

              if (updates.length > 0) {
                const batchResp = await fetchWithRetry(
                  wooUrl(wooConfig.url, `products/${wooProductId}/variations/batch`, wooConfig),
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ update: updates }),
                  }
                );
                if (batchResp.ok) {
                  console.log(`✓ Stock batch: ${productSku} — ${updates.length} variations updated`);
                  totalSuccess++;
                } else {
                  console.log(`✗ Stock batch failed for ${productSku}: ${batchResp.status}`);
                  totalFailed++;
                }
              } else {
                totalSuccess++; // No changes needed
              }
            }
          }

          // ── 4b. Price updates via batch API ──
          if (syncReasons.includes('price') && price) {
            const regularPrice = price.regular || 0;
            const salePrice = price.list || null;

            if (wooProducts[0].type === 'variable') {
              const varResp = await fetchWithRetry(
                wooUrl(wooConfig.url, `products/${wooProductId}/variations?per_page=100`, wooConfig),
                { headers: { 'Content-Type': 'application/json' } }
              );

              if (varResp.ok) {
                const wooVariations = await varResp.json();
                const updates = wooVariations.map((v: any) => ({
                  id: v.id,
                  regular_price: regularPrice.toString(),
                  sale_price: salePrice ? salePrice.toString() : '',
                }));

                const batchResp = await fetchWithRetry(
                  wooUrl(wooConfig.url, `products/${wooProductId}/variations/batch`, wooConfig),
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ update: updates }),
                  }
                );
                if (batchResp.ok) {
                  console.log(`✓ Price batch: ${productSku} — ${updates.length} variations`);
                  totalSuccess++;
                } else {
                  console.log(`✗ Price batch failed for ${productSku}: ${batchResp.status}`);
                  totalFailed++;
                }
              }
            } else {
              // Simple product
              const updateResp = await fetchWithRetry(
                wooUrl(wooConfig.url, `products/${wooProductId}`, wooConfig),
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    regular_price: regularPrice.toString(),
                    sale_price: salePrice ? salePrice.toString() : '',
                  }),
                }
              );
              if (updateResp.ok) {
                console.log(`✓ Price: ${productSku} — €${regularPrice}`);
                totalSuccess++;
              } else {
                totalFailed++;
              }
            }
          }

          totalProcessed++;

          // Rate limit buffer: ~200ms between products
          await new Promise(r => setTimeout(r, 200));

        } catch (err: any) {
          console.error(`Error syncing ${productSku}:`, err.message);
          allResults.push({ sku: productSku, success: false, reason: err.message });
          totalFailed++;
        }
      }

      // ── 5. Clear processed items from queue ──
      for (const sync of syncs) {
        await supabase
          .from('pending_product_syncs')
          .delete()
          .eq('product_id', sync.product_id)
          .eq('reason', sync.reason);
      }
    }

    // ── 6. Log to changelog ──
    if (totalProcessed > 0) {
      const tenantId = pendingSyncs[0].tenant_id;
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'BATCH_WOO_SYNC',
        description: `Batch sync: ${totalSuccess} geslaagd, ${totalFailed} mislukt van ${totalProcessed} producten`,
        metadata: {
          processed: totalProcessed,
          success: totalSuccess,
          failed: totalFailed,
          results: allResults.slice(0, 20),
        },
      });
    }

    console.log(`Batch sync complete: ${totalProcessed} products, ${totalSuccess} success, ${totalFailed} failed`);

    return new Response(
      JSON.stringify({ processed: totalProcessed, success: totalSuccess, failed: totalFailed }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Batch sync error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
