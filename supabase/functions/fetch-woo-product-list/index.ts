import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 5000)));
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        const delay = parseInt(res.headers.get('Retry-After') || '5') * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) { lastError = e as Error; }
  }
  throw lastError || new Error('All fetch attempts failed');
}

interface FieldDiff {
  field: string;
  old_value: string | null;
  new_value: string | null;
  change_type: string;
}

function detectChanges(existing: any, incoming: any): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  // Price changes
  if ((existing.regular_price || '') !== (incoming.regular_price || '')) {
    diffs.push({ field: 'regular_price', old_value: existing.regular_price, new_value: incoming.regular_price, change_type: 'price_change' });
  }
  if ((existing.sale_price || '') !== (incoming.sale_price || '')) {
    diffs.push({ field: 'sale_price', old_value: existing.sale_price, new_value: incoming.sale_price, change_type: 'price_change' });
  }

  // Stock changes
  if ((existing.stock_status || '') !== (incoming.stock_status || '')) {
    diffs.push({ field: 'stock_status', old_value: existing.stock_status, new_value: incoming.stock_status, change_type: 'stock_change' });
  }
  if (existing.stock_quantity !== incoming.stock_quantity) {
    diffs.push({ field: 'stock_quantity', old_value: String(existing.stock_quantity ?? ''), new_value: String(incoming.stock_quantity ?? ''), change_type: 'stock_change' });
  }

  // Status changes
  if ((existing.status || '') !== (incoming.status || '')) {
    diffs.push({ field: 'status', old_value: existing.status, new_value: incoming.status, change_type: 'status_change' });
  }

  // Content changes
  if ((existing.name || '') !== (incoming.name || '')) {
    diffs.push({ field: 'name', old_value: existing.name, new_value: incoming.name, change_type: 'content_change' });
  }
  if ((existing.slug || '') !== (incoming.slug || '')) {
    diffs.push({ field: 'slug', old_value: existing.slug, new_value: incoming.slug, change_type: 'content_change' });
  }

  // Image changes
  const existingImgCount = Array.isArray(existing.images) ? existing.images.length : 0;
  const incomingImgCount = Array.isArray(incoming.images) ? incoming.images.length : 0;
  if (existingImgCount !== incomingImgCount) {
    diffs.push({ field: 'images', old_value: `${existingImgCount} afbeeldingen`, new_value: `${incomingImgCount} afbeeldingen`, change_type: 'image_change' });
  }

  // Category changes
  const existingCats = JSON.stringify((existing.categories || []).map((c: any) => c.id || c).sort());
  const incomingCats = JSON.stringify((incoming.categories || []).map((c: any) => c.id || c).sort());
  if (existingCats !== incomingCats) {
    diffs.push({ field: 'categories', old_value: existingCats, new_value: incomingCats, change_type: 'content_change' });
  }

  return diffs;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { tenantId } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: config, error: cfgErr } = await supabase
      .from('tenant_config')
      .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
      .eq('tenant_id', tenantId)
      .single();
    if (cfgErr || !config) throw new Error(`Config not found: ${cfgErr?.message}`);

    // Fetch all existing woo_products for comparison
    const { data: existingProducts } = await supabase
      .from('woo_products')
      .select('id, woo_id, sku, name, slug, status, stock_status, stock_quantity, regular_price, sale_price, images, categories')
      .eq('tenant_id', tenantId);

    const existingByWooId = new Map<number, any>();
    if (existingProducts) {
      for (const ep of existingProducts) existingByWooId.set(ep.woo_id, ep);
    }

    // Fetch WooCommerce products
    let page = 1;
    let allProducts: any[] = [];
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`${config.woocommerce_url}/wp-json/wc/v3/products`);
      url.searchParams.append('consumer_key', config.woocommerce_consumer_key);
      url.searchParams.append('consumer_secret', config.woocommerce_consumer_secret);
      url.searchParams.append('per_page', '100');
      url.searchParams.append('page', page.toString());
      url.searchParams.append('orderby', 'id');
      url.searchParams.append('order', 'asc');
      url.searchParams.append('status', 'any');

      console.log(`Fetching page ${page}...`);
      const response = await fetchWithRetry(url.toString(), { headers: { 'Content-Type': 'application/json' } });

      if (!response.ok) {
        const text = await response.text();
        if (text.includes('sgcapt') || text.includes('<html')) {
          throw new Error('Blocked by hosting bot protection');
        }
        throw new Error(`API error ${response.status}: ${text.substring(0, 200)}`);
      }

      const products = await response.json();
      if (!Array.isArray(products) || products.length === 0) { hasMore = false; break; }

      allProducts = allProducts.concat(products);
      const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1');
      hasMore = page < totalPages;
      page++;
      if (hasMore) await new Promise(r => setTimeout(r, 300));
    }

    console.log(`Fetched ${allProducts.length} WooCommerce products`);

    // SKU matching
    const { data: pimProducts } = await supabase
      .from('products').select('id, sku').eq('tenant_id', tenantId);
    const skuToProductId = new Map<string, string>();
    if (pimProducts) for (const p of pimProducts) skuToProductId.set(p.sku, p.id);

    const now = new Date().toISOString();
    const allChanges: any[] = [];
    let newProducts = 0;
    let changedProducts = 0;
    let unchangedProducts = 0;

    // Process & upsert in batches
    const batchSize = 200;
    let upsertedCount = 0;

    for (let i = 0; i < allProducts.length; i += batchSize) {
      const batch = allProducts.slice(i, i + batchSize).map((wp: any) => {
        const incoming = {
          name: wp.name || 'Untitled',
          slug: wp.slug || null,
          status: wp.status || 'publish',
          stock_status: wp.stock_status || 'instock',
          stock_quantity: wp.stock_quantity ?? null,
          regular_price: wp.regular_price || null,
          sale_price: wp.sale_price || null,
          categories: wp.categories || [],
          images: (wp.images || []).map((img: any) => ({ id: img.id, src: img.src, alt: img.alt })),
        };

        const existing = existingByWooId.get(wp.id);
        let fetchDiff: any = null;

        if (existing) {
          const diffs = detectChanges(existing, incoming);
          if (diffs.length > 0) {
            fetchDiff = { changes: diffs, detected_at: now, change_count: diffs.length };
            changedProducts++;

            // Queue change log entries
            for (const diff of diffs) {
              allChanges.push({
                tenant_id: tenantId,
                woo_product_id: existing.id,
                woo_id: wp.id,
                sku: wp.sku || null,
                product_name: wp.name,
                change_type: diff.change_type,
                field_name: diff.field,
                old_value: diff.old_value,
                new_value: diff.new_value,
                detected_at: now,
              });
            }
          } else {
            unchangedProducts++;
          }
        } else {
          fetchDiff = { changes: [{ field: 'product', old_value: null, new_value: 'new', change_type: 'new_product' }], detected_at: now, change_count: 1 };
          newProducts++;
        }

        return {
          tenant_id: tenantId,
          woo_id: wp.id,
          sku: wp.sku || null,
          name: incoming.name,
          slug: incoming.slug,
          permalink: wp.permalink || null,
          status: incoming.status,
          stock_status: incoming.stock_status,
          stock_quantity: incoming.stock_quantity,
          regular_price: incoming.regular_price,
          sale_price: incoming.sale_price,
          categories: incoming.categories,
          tags: wp.tags || [],
          images: incoming.images,
          type: wp.type || 'simple',
          last_fetched_at: now,
          product_id: wp.sku ? (skuToProductId.get(wp.sku) || null) : null,
          fetch_diff: fetchDiff,
          previous_data: existing ? {
            name: existing.name,
            status: existing.status,
            stock_status: existing.stock_status,
            stock_quantity: existing.stock_quantity,
            regular_price: existing.regular_price,
            sale_price: existing.sale_price,
          } : null,
        };
      });

      const { error } = await supabase.from('woo_products').upsert(batch, { onConflict: 'tenant_id,woo_id' });
      if (error) console.error('Upsert error:', error);
      else upsertedCount += batch.length;
    }

    // Insert change log entries in batches
    if (allChanges.length > 0) {
      // Need woo_product_id for new entries — re-fetch after upsert
      const { data: updatedProducts } = await supabase
        .from('woo_products')
        .select('id, woo_id')
        .eq('tenant_id', tenantId);

      const wooIdToUuid = new Map<number, string>();
      if (updatedProducts) for (const p of updatedProducts) wooIdToUuid.set(p.woo_id, p.id);

      const validChanges = allChanges
        .map(c => ({ ...c, woo_product_id: wooIdToUuid.get(c.woo_id) || c.woo_product_id }))
        .filter(c => c.woo_product_id);

      for (let i = 0; i < validChanges.length; i += 500) {
        const changeBatch = validChanges.slice(i, i + 500);
        await supabase.from('woo_product_changes').insert(changeBatch);
      }
      console.log(`Logged ${validChanges.length} field changes`);
    }

    const summary = {
      fetched: allProducts.length,
      upserted: upsertedCount,
      new_products: newProducts,
      changed_products: changedProducts,
      unchanged_products: unchangedProducts,
      total_field_changes: allChanges.length,
    };

    console.log('Delta summary:', summary);

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
