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

    console.log('Starting sync-new-products...');

    // Query products that don't have a WooCommerce ID yet (primary method)
    const { data: newProducts, error: dbError } = await supabase
      .from('products')
      .select('id, sku, title, tenant_id')
      .is('woocommerce_product_id', null)
      .not('sku', 'is', null)
      .not('title', 'is', null);

    if (dbError) throw dbError;

    if (!newProducts || newProducts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No new products to create', new_products_found: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${newProducts.length} products without woocommerce_product_id`);

    // Check which products already have pending jobs to avoid duplicates
    let missingProducts = newProducts;
    if (newProducts.length > 0) {
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

      missingProducts = newProducts.filter(p => !alreadyQueued.has(p.id));
      if (missingProducts.length < newProducts.length) {
        console.log(`Filtered out ${newProducts.length - missingProducts.length} products already queued`);
      }
    }

    console.log(`${missingProducts.length} new products to create`);

    if (missingProducts.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'All new products already queued',
          new_products_found: 0,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create jobs in batches of 3 (creation is heavier than update)
    const BATCH_SIZE = 3;
    let jobsCreated = 0;

    for (let i = 0; i < missingProducts.length; i += BATCH_SIZE) {
      const batch = missingProducts.slice(i, i + BATCH_SIZE);
      const productIds = batch.map(p => p.id);
      const tenantId = batch[0].tenant_id;

      await supabase.from('jobs').insert({
        type: 'SYNC_TO_WOO',
        state: 'ready',
        payload: { productIds, syncScope: 'FULL', isNewProduct: true },
        tenant_id: tenantId,
        scope: 'FULL',
        priority: 30, // lower than realtime price/stock
      });

      jobsCreated++;
    }

    console.log(`Created ${jobsCreated} jobs for ${missingProducts.length} new products`);

    return new Response(
      JSON.stringify({
        success: true,
        new_products_found: missingProducts.length,
        jobs_created: jobsCreated,
        missing_skus: missingProducts.slice(0, 50).map(p => p.sku),
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
