import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const { data: dbProducts } = await supabase
      .from('products')
      .select('id, sku, title, tenant_id');

    if (!dbProducts || dbProducts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No products in database' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${dbProducts.length} products in database`);

    // Get tenant config
    const { data: tenantConfig } = await supabase
      .from('tenant_config')
      .select('*')
      .limit(1)
      .single();

    if (!tenantConfig) {
      throw new Error('No tenant config found');
    }

    // Get ALL products from WooCommerce
    const allWooProducts: any[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      const url = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products`);
      url.searchParams.append('per_page', '100');
      url.searchParams.append('page', page.toString());
      url.searchParams.append('status', 'any');
      url.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
      url.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);

      const response = await fetch(url.toString());
      
      if (!response.ok) {
        console.error(`WooCommerce API error on page ${page}: ${response.status}`);
        break;
      }

      const products = await response.json();
      allWooProducts.push(...products);
      
      if (products.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    console.log(`Found ${allWooProducts.length} products in WooCommerce`);

    // Find products that don't exist in WooCommerce
    const wooSkus = new Set(allWooProducts.map((p: any) => p.sku).filter(Boolean));
    const missingProducts = dbProducts.filter(p => p.sku && p.title && !wooSkus.has(p.sku));

    console.log(`Found ${missingProducts.length} new products to create`);

    if (missingProducts.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'All products already exist in WooCommerce',
          database_products: dbProducts.length,
          woocommerce_products: allWooProducts.length
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create jobs for new products (in batches of 10)
    const BATCH_SIZE = 10;
    let jobsCreated = 0;

    for (let i = 0; i < missingProducts.length; i += BATCH_SIZE) {
      const batch = missingProducts.slice(i, i + BATCH_SIZE);
      const productIds = batch.map(p => p.id);
      const tenantId = batch[0].tenant_id;

      await supabase.from('jobs').insert({
        type: 'CREATE_NEW_PRODUCTS',
        state: 'ready',
        payload: { productIds },
        tenant_id: tenantId
      });

      jobsCreated++;
      console.log(`Created job for ${batch.length} new products (batch ${jobsCreated})`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        new_products_found: missingProducts.length,
        jobs_created: jobsCreated,
        missing_skus: missingProducts.map(p => p.sku)
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in sync-new-products:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
