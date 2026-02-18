import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    console.log('Starting sync-new-products (local cache lookup)...');

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

    // Use local woo_products table instead of WooCommerce API
    const { data: wooProducts, error: wooError } = await supabase
      .from('woo_products')
      .select('sku');

    if (wooError) throw wooError;

    const wooSkus = new Set((wooProducts || []).map((p: any) => p.sku).filter(Boolean));
    console.log(`Found ${wooSkus.size} SKUs in local WooCommerce cache`);

    // Find products that don't exist in WooCommerce
    const missingProducts = dbProducts.filter(p => p.sku && p.title && !wooSkus.has(p.sku));

    console.log(`Found ${missingProducts.length} new products to create`);

    if (missingProducts.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'All products already exist in WooCommerce',
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
