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

    console.log(`Creating sync job for ${products.length} products`);

    const productIds = products.map(p => p.id);
    
    const { error: jobError } = await supabase
      .from('jobs')
      .insert({
        type: 'SYNC_TO_WOO',
        state: 'ready',
        tenant_id: tenant.id,
        payload: { productIds },
      });

    if (jobError) {
      console.error('Error creating job:', jobError);
      throw jobError;
    }

    console.log(`Created sync job for ${products.length} products`);

    // Trigger the job scheduler to process immediately
    const { error: schedulerError } = await supabase.functions.invoke('job-scheduler');
    
    if (schedulerError) {
      console.warn('Failed to trigger job scheduler:', schedulerError);
      // Don't throw - job will still be processed eventually
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Created sync job for ${products.length} products`,
        jobsCreated: 1,
        productsQueued: products.length,
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
