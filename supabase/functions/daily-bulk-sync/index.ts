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

    console.log('Starting daily bulk sync...');

    // Load config for max queue size
    const { data: batchConfig } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'batch_sync_config')
      .maybeSingle();

    const config = (batchConfig?.value as Record<string, number>) || {};
    const MAX_QUEUE_SIZE = config.max_queue_size || 10;

    // Check current queue depth
    const { count: currentQueueSize } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .in('state', ['ready', 'processing']);

    if ((currentQueueSize || 0) >= MAX_QUEUE_SIZE) {
      console.log(`Queue already has ${currentQueueSize} jobs (max ${MAX_QUEUE_SIZE}) — skipping daily bulk sync`);
      return new Response(
        JSON.stringify({ success: false, reason: 'queue_full', currentQueueSize }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      );
    }

    // Get all active tenants
    const { data: tenants, error: tenantsError } = await supabase
      .from('tenants')
      .select('id, name')
      .eq('active', true);

    if (tenantsError) {
      console.error('Error fetching tenants:', tenantsError);
      throw tenantsError;
    }

    console.log(`Found ${tenants?.length || 0} active tenants`);

    let totalJobsCreated = 0;

    for (const tenant of tenants || []) {
      const { data: products, error: productsError } = await supabase
        .from('products')
        .select('id')
        .eq('tenant_id', tenant.id);

      if (productsError) {
        console.error(`Error fetching products for tenant ${tenant.name}:`, productsError);
        continue;
      }

      if (!products || products.length === 0) {
        console.log(`No products found for tenant ${tenant.name}`);
        continue;
      }

      const productIds = products.map(p => p.id);
      console.log(`Creating bulk sync job for ${productIds.length} products (tenant: ${tenant.name})`);

      // Create a single job with ALL product IDs — the sync function handles internal batching
      const { error: jobError } = await supabase
        .from('jobs')
        .insert({
          type: 'SYNC_TO_WOO',
          state: 'ready',
          payload: { productIds },
          tenant_id: tenant.id
        });

      if (jobError) {
        console.error(`Error creating job for tenant ${tenant.name}:`, jobError);
      } else {
        totalJobsCreated++;
        console.log(`✓ Created bulk sync job for tenant ${tenant.name}`);
      }
    }

    console.log(`Daily bulk sync completed. Created ${totalJobsCreated} jobs.`);

    return new Response(
      JSON.stringify({
        success: true,
        tenantsProcessed: tenants?.length || 0,
        jobsCreated: totalJobsCreated
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in daily bulk sync:', error);
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
