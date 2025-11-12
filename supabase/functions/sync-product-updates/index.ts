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

    console.log('Starting sync-product-updates...');

    // Check for pending product syncs (products that have changed)
    const { data: pendingSyncs } = await supabase
      .from('pending_product_syncs')
      .select('product_id, tenant_id, reason')
      .lt('created_at', new Date(Date.now() - 30000).toISOString()); // 30 sec debounce

    if (!pendingSyncs || pendingSyncs.length === 0) {
      console.log('No pending product updates');
      return new Response(
        JSON.stringify({ success: true, message: 'No pending updates' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${pendingSyncs.length} products with pending updates`);

    // Group by tenant
    const byTenant = new Map<string, Set<string>>();
    
    for (const sync of pendingSyncs) {
      if (!byTenant.has(sync.tenant_id)) {
        byTenant.set(sync.tenant_id, new Set());
      }
      byTenant.get(sync.tenant_id)!.add(sync.product_id);
    }

    let jobsCreated = 0;

    // Create update jobs per tenant (batches of 20)
    for (const [tenantId, productIdsSet] of byTenant) {
      const productIds = Array.from(productIdsSet);
      const BATCH_SIZE = 20;

      for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
        const batch = productIds.slice(i, i + BATCH_SIZE);

        await supabase.from('jobs').insert({
          type: 'UPDATE_PRODUCTS',
          state: 'ready',
          payload: { productIds: batch },
          tenant_id: tenantId
        });

        jobsCreated++;
        console.log(`Created update job for ${batch.length} products (tenant: ${tenantId})`);
      }
    }

    // Clear processed pending syncs
    await supabase
      .from('pending_product_syncs')
      .delete()
      .lt('created_at', new Date(Date.now() - 30000).toISOString());

    console.log(`Created ${jobsCreated} update jobs`);

    return new Response(
      JSON.stringify({
        success: true,
        products_to_update: pendingSyncs.length,
        jobs_created: jobsCreated
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in sync-product-updates:', error);
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
