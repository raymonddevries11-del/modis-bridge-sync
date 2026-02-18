import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Fetch SKUs from local woo_products cache */
async function getLocalWooSkus(supabase: any): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('woo_products')
    .select('sku');

  if (error) throw error;
  return new Set((data || []).map((p: any) => p.sku).filter(Boolean));
}

/** Fallback: fetch SKUs from WooCommerce API with pagination and backoff */
async function getApiWooSkus(config: any): Promise<Set<string>> {
  const skus = new Set<string>();
  let page = 1;
  let consecutiveErrors = 0;
  const MAX_PAGES = 50;
  const BASE_DELAY = 800;

  while (page <= MAX_PAGES) {
    const url = new URL(`${config.woocommerce_url}/wp-json/wc/v3/products`);
    url.searchParams.append('per_page', '100');
    url.searchParams.append('page', page.toString());
    url.searchParams.append('status', 'any');
    url.searchParams.append('consumer_key', config.woocommerce_consumer_key);
    url.searchParams.append('consumer_secret', config.woocommerce_consumer_secret);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PIM-Sync/1.0)',
          'Accept': 'application/json',
        },
      });

      if (response.status === 429 || response.status === 503) {
        consecutiveErrors++;
        const delay = BASE_DELAY * Math.pow(2, Math.min(consecutiveErrors, 5));
        console.warn(`API rate limited (${response.status}), backing off ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue; // retry same page
      }

      if (!response.ok) {
        console.error(`WooCommerce API error page ${page}: ${response.status}`);
        break;
      }

      consecutiveErrors = 0;
      const products = await response.json();
      for (const p of products) {
        if (p.sku) skus.add(p.sku);
      }

      if (products.length < 100) break;
      page++;

      // polite delay between pages
      await new Promise(r => setTimeout(r, BASE_DELAY));
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        console.error('Too many consecutive API errors, aborting fallback');
        break;
      }
      const delay = BASE_DELAY * Math.pow(2, consecutiveErrors);
      console.warn(`API fetch error, retrying in ${delay}ms:`, e);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return skus;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Starting sync-new-products...');

    // Get all product SKUs from database
    const { data: dbProducts, error: dbError } = await supabase
      .from('products')
      .select('id, sku, title, tenant_id');

    if (dbError) throw dbError;

    if (!dbProducts || dbProducts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No products in database' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${dbProducts.length} products in database`);

    // Step 1: Try local cache
    let wooSkus: Set<string>;
    let source = 'local_cache';

    try {
      wooSkus = await getLocalWooSkus(supabase);
      console.log(`Local cache: ${wooSkus.size} SKUs`);

      // If cache is suspiciously empty, fall back to API
      if (wooSkus.size === 0) {
        console.warn('Local cache empty, falling back to WooCommerce API');
        throw new Error('empty_cache');
      }
    } catch (cacheError) {
      // Step 2: Fallback to API with pagination + backoff
      console.log('Falling back to WooCommerce API...');
      source = 'api_fallback';

      const { data: tenantConfig } = await supabase
        .from('tenant_config')
        .select('*')
        .limit(1)
        .single();

      if (!tenantConfig) throw new Error('No tenant config found');

      wooSkus = await getApiWooSkus(tenantConfig);
      console.log(`API fallback: ${wooSkus.size} SKUs`);
    }

    // Find products that don't exist in WooCommerce
    const potentiallyMissing = dbProducts.filter(p => p.sku && p.title && !wooSkus.has(p.sku));

    // Check which products already have pending jobs to avoid duplicates
    let missingProducts = potentiallyMissing;
    if (potentiallyMissing.length > 0) {
      const potentialIds = potentiallyMissing.map(p => p.id);
      
      // Fetch existing ready/processing jobs for these product IDs
      const { data: existingJobs } = await supabase
        .from('jobs')
        .select('payload')
        .in('state', ['ready', 'processing'])
        .in('type', ['CREATE_NEW_PRODUCTS', 'SYNC_TO_WOO']);

      const alreadyQueued = new Set<string>();
      if (existingJobs) {
        for (const job of existingJobs) {
          const ids = (job.payload as any)?.productIds;
          if (Array.isArray(ids)) {
            for (const id of ids) alreadyQueued.add(id);
          }
        }
      }

      missingProducts = potentiallyMissing.filter(p => !alreadyQueued.has(p.id));
      if (missingProducts.length < potentiallyMissing.length) {
        console.log(`Filtered out ${potentiallyMissing.length - missingProducts.length} products already queued`);
      }
    }

    console.log(`Found ${missingProducts.length} new products to create (source: ${source})`);

    if (missingProducts.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'All products already exist in WooCommerce',
          source,
          database_products: dbProducts.length,
          woocommerce_products: wooSkus.size,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create jobs for new products (in batches of 3 to avoid 504 timeouts)
    const BATCH_SIZE = 3;
    let jobsCreated = 0;

    for (let i = 0; i < missingProducts.length; i += BATCH_SIZE) {
      const batch = missingProducts.slice(i, i + BATCH_SIZE);
      const productIds = batch.map(p => p.id);
      const tenantId = batch[0].tenant_id;

      await supabase.from('jobs').insert({
        type: 'CREATE_NEW_PRODUCTS',
        state: 'ready',
        payload: { productIds },
        tenant_id: tenantId,
      });

      jobsCreated++;
    }

    console.log(`Created ${jobsCreated} jobs for ${missingProducts.length} new products`);

    return new Response(
      JSON.stringify({
        success: true,
        source,
        new_products_found: missingProducts.length,
        jobs_created: jobsCreated,
        missing_skus: missingProducts.map(p => p.sku),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in sync-new-products:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
