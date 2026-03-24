// Batch WooCommerce Sync v3 — rate limited, self-continuing, 25 per batch
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BATCH_SIZE = 25;
const INTER_PRODUCT_DELAY_MS = 500;

// --- Circuit Breaker ---
const CIRCUIT_BREAKER_KEY = 'woo_sync_circuit_breaker';

interface CircuitBreakerState {
  paused: boolean;
  consecutive_blocks: number;
  paused_at: string | null;
  last_block_at: string | null;
  total_blocks_24h: number;
}

async function getCircuitBreaker(supabase: any): Promise<CircuitBreakerState> {
  const { data } = await supabase.from('config').select('value').eq('key', CIRCUIT_BREAKER_KEY).single();
  if (data?.value) return data.value as CircuitBreakerState;
  return { paused: false, consecutive_blocks: 0, paused_at: null, last_block_at: null, total_blocks_24h: 0 };
}

// --- Adaptive Rate Limiter (same as push-to-woocommerce) ---
class AdaptiveRateLimiter {
  private baseDelay: number;
  private currentDelay: number;
  private consecutiveBlocks = 0;
  private readonly maxDelay: number;

  constructor(baseDelayMs = 800, maxDelayMs = 5000) {
    this.baseDelay = baseDelayMs;
    this.currentDelay = baseDelayMs;
    this.maxDelay = maxDelayMs;
  }

  async wait() {
    await new Promise(r => setTimeout(r, this.currentDelay));
  }

  onSuccess() {
    this.consecutiveBlocks = 0;
    this.currentDelay = Math.max(this.baseDelay, this.currentDelay * 0.8);
  }

  onBlock() {
    this.consecutiveBlocks++;
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
    console.warn(`Bot block detected (${this.consecutiveBlocks} consecutive). Delay now ${this.currentDelay}ms`);
  }

  get delay() { return this.currentDelay; }
  get isThrottled() { return this.consecutiveBlocks >= 3; }
}

// --- Helpers ---

interface WooConfig {
  url: string;
  consumerKey: string;
  consumerSecret: string;
}

function normalizeSize(size: string): string {
  return size.toLowerCase().replace(/\s+/g, '').trim();
}

function isHtmlResponse(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  return lower.startsWith('<html') || lower.startsWith('<!doctype') || lower.includes('sgcapt') || lower.includes('captcha');
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  rateLimiter: AdaptiveRateLimiter,
  maxRetries = 2,
): Promise<{ ok: boolean; json: any | null; blocked: boolean; status: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await rateLimiter.wait();
    try {
      const resp = await fetch(url, {
        ...options,
        headers: {
          ...((options.headers as Record<string, string>) || {}),
          'User-Agent': 'Mozilla/5.0 (compatible; PIM-Sync/1.0)',
          'Accept': 'application/json',
        },
      });

      if (resp.status === 429) {
        const wait = parseInt(resp.headers.get('Retry-After') || '5') * 1000;
        console.log(`Rate limited, waiting ${wait}ms`);
        rateLimiter.onBlock();
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      const text = await resp.text();
      if (isHtmlResponse(text)) {
        rateLimiter.onBlock();
        if (rateLimiter.isThrottled) {
          return { ok: false, json: null, blocked: true, status: resp.status };
        }
        continue;
      }

      rateLimiter.onSuccess();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { ok: resp.ok, json, blocked: false, status: resp.status };
    } catch (e) {
      console.error(`Fetch attempt ${attempt + 1} failed:`, e);
      if (attempt === maxRetries) {
        return { ok: false, json: null, blocked: false, status: 0 };
      }
    }
  }
  return { ok: false, json: null, blocked: false, status: 0 };
}

function wooUrl(base: string, path: string, config: WooConfig): string {
  const u = new URL(`${base}/wp-json/wc/v3/${path}`);
  u.searchParams.set('consumer_key', config.consumerKey);
  u.searchParams.set('consumer_secret', config.consumerSecret);
  return u.toString();
}

// --- Self-invoke to continue next batch ---
async function selfInvoke(supabaseUrl: string, anonKey: string) {
  try {
    await fetch(`${supabaseUrl}/functions/v1/batch-woo-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ continuation: true }),
    });
    console.log('→ Self-invoked for next batch');
  } catch (e) {
    console.error('Self-invoke failed:', e);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // --- Circuit breaker check ---
    const cbState = await getCircuitBreaker(supabase);
    if (cbState.paused) {
      console.warn('🛑 Circuit breaker is ACTIVE — batch sync skipped.');
      return new Response(JSON.stringify({
        message: 'Sync paused by circuit breaker',
        paused: true,
        processed: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 1. Fetch pending syncs (max BATCH_SIZE) ──
    const { data: pendingSyncs, error: fetchErr } = await supabase
      .from('pending_product_syncs')
      .select('product_id, tenant_id, reason, created_at')
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchErr) throw fetchErr;
    if (!pendingSyncs || pendingSyncs.length === 0) {
      return new Response(JSON.stringify({ message: 'No pending syncs', processed: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Batch sync starting: ${pendingSyncs.length} items (batch size ${BATCH_SIZE})`);

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

      const rateLimiter = new AdaptiveRateLimiter(500, 5000);
      const productIds = [...new Set(syncs.map(s => s.product_id))];

      // ── 3. Bulk fetch product data ──
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
        await supabase.from('pending_product_syncs').delete().in('product_id', productIds);
        continue;
      }

      // ── 4. Process each product (with rate limiting + delay) ──
      for (const product of products) {
        const productSku = product.sku;
        const syncReasons = syncs.filter(s => s.product_id === product.id).map(s => s.reason);

        // Abort if rate limiter is fully throttled (3+ consecutive blocks)
        if (rateLimiter.isThrottled) {
          console.warn(`⚠ Rate limiter throttled — stopping batch early at ${totalProcessed} products`);
          break;
        }

        try {
          // Search for WooCommerce product by SKU
          const searchResult = await fetchWithRetry(
            wooUrl(wooConfig.url, `products?sku=${encodeURIComponent(productSku)}&per_page=1`, wooConfig),
            { method: 'GET' },
            rateLimiter,
          );

          if (searchResult.blocked) {
            console.error(`SiteGround bot protection blocking API for ${productSku}`);
            allResults.push({ sku: productSku, success: false, reason: 'SiteGround bot block' });
            totalFailed++;
            continue;
          }

          if (!searchResult.ok || !searchResult.json) {
            allResults.push({ sku: productSku, success: false, reason: `Search failed: ${searchResult.status}` });
            totalFailed++;
            continue;
          }

          const wooProducts = searchResult.json;
          if (!Array.isArray(wooProducts) || wooProducts.length === 0) {
            allResults.push({ sku: productSku, success: false, reason: 'Not found in WooCommerce' });
            totalFailed++;
            continue;
          }

          const wooProductId = wooProducts[0].id;
          const wooProductData = wooProducts[0];
          const variants = (product.variants as any[]) || [];
          const priceData = product.product_prices as any;
          const price = Array.isArray(priceData) ? priceData[0] : priceData;

          // ── 4a. Stock updates ──
          if (syncReasons.includes('stock') && variants.length > 0) {
            const varResult = await fetchWithRetry(
              wooUrl(wooConfig.url, `products/${wooProductId}/variations?per_page=100`, wooConfig),
              { method: 'GET' },
              rateLimiter,
            );

            if (varResult.ok && varResult.json) {
              const wooVariations = varResult.json;
              const updates: any[] = [];

              for (const variant of variants) {
                const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
                const expectedSku = `${productSku}-${variant.maat_id}`;
                const legacySku = `${productSku}-${variant.size_label}`;

                const match = wooVariations.find((wv: any) => {
                  if (!wv.sku) return false;
                  const norm = normalizeSize(wv.sku);
                  return norm === normalizeSize(expectedSku) ||
                         norm === normalizeSize(legacySku) ||
                         wv.sku.endsWith(variant.size_label);
                });

                if (match && match.stock_quantity !== stockQty) {
                  updates.push({
                    id: match.id,
                    stock_quantity: stockQty,
                    manage_stock: true,
                    stock_status: stockQty > 0 ? 'instock' : 'outofstock',
                  });
                }
              }

              if (updates.length > 0) {
                const batchResult = await fetchWithRetry(
                  wooUrl(wooConfig.url, `products/${wooProductId}/variations/batch`, wooConfig),
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ update: updates }),
                  },
                  rateLimiter,
                );
                if (batchResult.ok) {
                  console.log(`✓ Stock batch: ${productSku} — ${updates.length} variations updated`);
                  totalSuccess++;
                } else {
                  console.log(`✗ Stock batch failed for ${productSku}: ${batchResult.status}`);
                  totalFailed++;
                }
              } else {
                totalSuccess++;
              }
            }
          }

          // ── 4b. Price updates ──
          if (syncReasons.includes('price') && price) {
            const regularPrice = price.regular || 0;
            const salePrice = price.list || null;

            if (wooProducts[0].type === 'variable') {
              const varResult = await fetchWithRetry(
                wooUrl(wooConfig.url, `products/${wooProductId}/variations?per_page=100`, wooConfig),
                { method: 'GET' },
                rateLimiter,
              );

              if (varResult.ok && varResult.json) {
                const wooVariations = varResult.json;
                const updates = wooVariations.map((v: any) => ({
                  id: v.id,
                  regular_price: regularPrice.toString(),
                  sale_price: salePrice ? salePrice.toString() : '',
                }));

                const batchResult = await fetchWithRetry(
                  wooUrl(wooConfig.url, `products/${wooProductId}/variations/batch`, wooConfig),
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ update: updates }),
                  },
                  rateLimiter,
                );
                if (batchResult.ok) {
                  console.log(`✓ Price batch: ${productSku} — ${updates.length} variations`);
                  totalSuccess++;
                } else {
                  console.log(`✗ Price batch failed for ${productSku}: ${batchResult.status}`);
                  totalFailed++;
                }
              }
            } else {
              const updateResult = await fetchWithRetry(
                wooUrl(wooConfig.url, `products/${wooProductId}`, wooConfig),
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    regular_price: regularPrice.toString(),
                    sale_price: salePrice ? salePrice.toString() : '',
                  }),
                },
                rateLimiter,
              );
              if (updateResult.ok) {
                console.log(`✓ Price: ${productSku} — €${regularPrice}`);
                totalSuccess++;
              } else {
                totalFailed++;
              }
            }
          }

          // Cache upsert
          try {
            await supabase.from('woo_products').upsert({
              tenant_id: tenantId,
              woo_id: wooProductId,
              product_id: product.id,
              sku: productSku,
              name: wooProductData.name || productSku,
              slug: wooProductData.slug || '',
              status: wooProductData.status || 'publish',
              type: wooProductData.type || 'variable',
              last_pushed_at: new Date().toISOString(),
            }, { onConflict: 'tenant_id,woo_id' });
          } catch (e) {
            console.error(`Cache upsert failed for ${productSku}:`, e);
          }

          totalProcessed++;

        } catch (err: any) {
          console.error(`Error syncing ${productSku}:`, err.message);
          allResults.push({ sku: productSku, success: false, reason: err.message });
          totalFailed++;
        }

        // ── Inter-product delay ──
        await new Promise(r => setTimeout(r, INTER_PRODUCT_DELAY_MS));
      }

      // ── 5. Clear processed items ──
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
      const firstTenantId = pendingSyncs[0].tenant_id;
      await supabase.from('changelog').insert({
        tenant_id: firstTenantId,
        event_type: 'BATCH_WOO_SYNC',
        description: `Batch sync: ${totalSuccess} geslaagd, ${totalFailed} mislukt van ${totalProcessed} producten (batch ${BATCH_SIZE})`,
        metadata: {
          processed: totalProcessed,
          success: totalSuccess,
          failed: totalFailed,
          batch_size: BATCH_SIZE,
          results: allResults.slice(0, 20),
        },
      });
    }

    console.log(`Batch sync complete: ${totalProcessed} products, ${totalSuccess} success, ${totalFailed} failed`);

    // ── 7. Self-continuation: check if more items remain ──
    const { count: remaining } = await supabase
      .from('pending_product_syncs')
      .select('id', { count: 'exact', head: true });

    if (remaining && remaining > 0) {
      console.log(`${remaining} items remaining in queue — scheduling next batch`);
      // Fire-and-forget self-invoke (don't await the full response)
      selfInvoke(supabaseUrl, anonKey);
    } else {
      console.log('Queue empty — no continuation needed');
    }

    return new Response(
      JSON.stringify({
        processed: totalProcessed,
        success: totalSuccess,
        failed: totalFailed,
        remaining: remaining || 0,
        continued: (remaining || 0) > 0,
      }),
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
