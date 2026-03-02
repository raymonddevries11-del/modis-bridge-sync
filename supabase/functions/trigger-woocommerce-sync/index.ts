import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    console.log('Triggering WooCommerce sync jobs...');

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
      return new Response(
        JSON.stringify({ success: false, reason: 'queue_full', currentQueueSize, maxQueueSize: MAX_QUEUE_SIZE }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get active tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id')
      .eq('active', true)
      .single();

    if (tenantError || !tenant) {
      console.error('Error fetching tenant:', tenantError);
      throw new Error('No active tenant found');
    }

    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id')
      .eq('tenant_id', tenant.id);

    if (productsError) {
      console.error('Error fetching products:', productsError);
      throw productsError;
    }

    if (!products || products.length === 0) {
      console.log('No products found to sync');
      return new Response(
        JSON.stringify({ message: 'No products to sync', jobsCreated: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const BATCH_SIZE = config.batch_size || 25;
    const productIds = products.map(p => p.id);
    const batches: string[][] = [];
    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      batches.push(productIds.slice(i, i + BATCH_SIZE));
    }

    console.log(`Creating ${batches.length} sync jobs for ${products.length} products (batch size ${BATCH_SIZE})`);

    const jobRows = batches.map(batch => ({
      type: 'SYNC_TO_WOO',
      state: 'ready' as const,
      tenant_id: tenant.id,
      payload: { productIds: batch },
    }));

    let actualJobsCreated = 0;
    for (const row of jobRows) {
      const { error: jobError } = await supabase.from('jobs').insert(row);
      if (jobError && jobError.code === '23505') {
        console.log(`Skipping duplicate sync job (already queued)`);
      } else if (jobError) {
        console.error('Error creating job:', jobError);
        throw jobError;
      } else {
        actualJobsCreated++;
      }
    }

    console.log(`Created ${actualJobsCreated}/${batches.length} sync jobs for ${products.length} products`);

    // Trigger the job scheduler to process immediately
    const { error: schedulerError } = await supabase.functions.invoke('job-scheduler');
    
    if (schedulerError) {
      console.warn('Failed to trigger job scheduler:', schedulerError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Created ${actualJobsCreated} sync jobs for ${products.length} products`,
        jobsCreated: actualJobsCreated,
        skippedDuplicates: batches.length - actualJobsCreated,
        productsQueued: products.length,
        batchSize: BATCH_SIZE,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error triggering sync:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
