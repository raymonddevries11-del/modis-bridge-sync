import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 5000)));
    }
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const delay = parseInt(response.headers.get('Retry-After') || '5') * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError || new Error('All fetch attempts failed');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { tenantId } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get WooCommerce config
    const { data: config, error: configError } = await supabase
      .from('tenant_config')
      .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !config) throw new Error(`Tenant config not found: ${configError?.message}`);

    const baseUrl = config.woocommerce_url;
    const ck = config.woocommerce_consumer_key;
    const cs = config.woocommerce_consumer_secret;

    // Fetch all products from WooCommerce with pagination
    let page = 1;
    const perPage = 100;
    let allProducts: any[] = [];
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`${baseUrl}/wp-json/wc/v3/products`);
      url.searchParams.append('consumer_key', ck);
      url.searchParams.append('consumer_secret', cs);
      url.searchParams.append('per_page', perPage.toString());
      url.searchParams.append('page', page.toString());
      url.searchParams.append('orderby', 'id');
      url.searchParams.append('order', 'asc');

      console.log(`Fetching WooCommerce products page ${page}...`);
      const response = await fetchWithRetry(url.toString(), {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const text = await response.text();
        // Check for SiteGround bot protection
        if (text.includes('sgcapt') || text.includes('<html')) {
          throw new Error('WooCommerce API blocked by hosting bot protection. Whitelist /wp-json/wc/v3/* in hosting security settings.');
        }
        throw new Error(`WooCommerce API error ${response.status}: ${text.substring(0, 200)}`);
      }

      const products = await response.json();
      if (!Array.isArray(products) || products.length === 0) {
        hasMore = false;
        break;
      }

      allProducts = allProducts.concat(products);
      console.log(`Fetched ${products.length} products (total: ${allProducts.length})`);

      const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1');
      hasMore = page < totalPages;
      page++;

      // Small delay to avoid rate limits
      if (hasMore) await new Promise(r => setTimeout(r, 300));
    }

    console.log(`Total WooCommerce products fetched: ${allProducts.length}`);

    // Get existing PIM products for SKU matching
    const { data: pimProducts } = await supabase
      .from('products')
      .select('id, sku')
      .eq('tenant_id', tenantId);

    const skuToProductId = new Map<string, string>();
    if (pimProducts) {
      for (const p of pimProducts) {
        skuToProductId.set(p.sku, p.id);
      }
    }

    // Upsert into woo_products
    const now = new Date().toISOString();
    const batchSize = 200;
    let upsertedCount = 0;

    for (let i = 0; i < allProducts.length; i += batchSize) {
      const batch = allProducts.slice(i, i + batchSize).map((wp: any) => ({
        tenant_id: tenantId,
        woo_id: wp.id,
        sku: wp.sku || null,
        name: wp.name || 'Untitled',
        slug: wp.slug || null,
        permalink: wp.permalink || null,
        status: wp.status || 'publish',
        stock_status: wp.stock_status || 'instock',
        stock_quantity: wp.stock_quantity ?? null,
        regular_price: wp.regular_price || null,
        sale_price: wp.sale_price || null,
        categories: wp.categories || [],
        tags: wp.tags || [],
        images: (wp.images || []).map((img: any) => ({
          id: img.id,
          src: img.src,
          alt: img.alt,
        })),
        type: wp.type || 'simple',
        last_fetched_at: now,
        product_id: wp.sku ? (skuToProductId.get(wp.sku) || null) : null,
      }));

      const { error: upsertError } = await supabase
        .from('woo_products')
        .upsert(batch, { onConflict: 'tenant_id,woo_id' });

      if (upsertError) {
        console.error(`Upsert batch error:`, upsertError);
      } else {
        upsertedCount += batch.length;
      }
    }

    console.log(`Upserted ${upsertedCount} WooCommerce products`);

    return new Response(
      JSON.stringify({
        success: true,
        fetched: allProducts.length,
        upserted: upsertedCount,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
