import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Auto-retry failed WooCommerce pushes.
 * 
 * Picks up products from pending_product_syncs with auto_retry reasons,
 * groups them into small batches, and creates SYNC_TO_WOO jobs.
 * 
 * Designed to run on a cron schedule (e.g., every 10 minutes).
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    console.log('Auto-retry failed pushes starting...');

    // Load retry config
    const { data: configData } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'auto_retry_config')
      .maybeSingle();

    const config = (configData?.value as Record<string, number>) || {};
    const MAX_RETRY_BATCH = config.max_retry_batch || 10;
    const MIN_AGE_SECONDS = config.min_age_seconds || 300; // Wait at least 5 min before retry
    const MAX_PENDING_JOBS = config.max_pending_jobs || 5;

    // Check current queue depth — don't add retries if queue is busy
    const { count: activeJobs } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .in('state', ['ready', 'processing']);

    if ((activeJobs || 0) >= MAX_PENDING_JOBS) {
      console.log(`Queue has ${activeJobs} active jobs (limit ${MAX_PENDING_JOBS}), skipping retry`);
      return new Response(JSON.stringify({
        success: true,
        message: 'Skipped — queue busy',
        activeJobs,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get active tenant
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('active', true)
      .single();

    if (!tenant) {
      throw new Error('No active tenant found');
    }

    // Find pending retries older than MIN_AGE_SECONDS
    const cutoff = new Date(Date.now() - MIN_AGE_SECONDS * 1000).toISOString();
    const { data: pendingRetries, error: pendingError } = await supabase
      .from('pending_product_syncs')
      .select('product_id, reason, created_at')
      .eq('tenant_id', tenant.id)
      .like('reason', 'auto_retry:%')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(MAX_RETRY_BATCH);

    if (pendingError) throw pendingError;

    if (!pendingRetries || pendingRetries.length === 0) {
      console.log('No pending retries found');
      return new Response(JSON.stringify({
        success: true,
        message: 'No pending retries',
        activeJobs: activeJobs || 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const productIds = [...new Set(pendingRetries.map(p => p.product_id))];
    const errorTypes = [...new Set(pendingRetries.map(p => p.reason.replace('auto_retry:', '')))];

    console.log(`Found ${productIds.length} products to retry (error types: ${errorTypes.join(', ')})`);

    // Check retry count from changelog to avoid infinite retries
    const { data: recentRetries } = await supabase
      .from('changelog')
      .select('metadata')
      .eq('tenant_id', tenant.id)
      .eq('event_type', 'WOO_PUSH_FAILED')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(500);

    // Count retries per product in last 24h
    const retryCountMap = new Map<string, number>();
    for (const entry of recentRetries || []) {
      const pid = (entry.metadata as any)?.productId;
      if (pid) retryCountMap.set(pid, (retryCountMap.get(pid) || 0) + 1);
    }

    // Filter out products that have been retried too many times (max 5 per 24h)
    const MAX_RETRIES_PER_DAY = config.max_retries_per_day || 5;
    const eligibleIds = productIds.filter(id => {
      const count = retryCountMap.get(id) || 0;
      if (count >= MAX_RETRIES_PER_DAY) {
        console.log(`Skipping product ${id} — ${count} retries in last 24h (max ${MAX_RETRIES_PER_DAY})`);
        return false;
      }
      return true;
    });

    if (eligibleIds.length === 0) {
      // Clean up exhausted retries
      await supabase
        .from('pending_product_syncs')
        .delete()
        .in('product_id', productIds)
        .like('reason', 'auto_retry:%');

      console.log('All pending retries exhausted (max retries per day reached)');
      
      await supabase.from('changelog').insert({
        tenant_id: tenant.id,
        event_type: 'AUTO_RETRY_EXHAUSTED',
        description: `${productIds.length} producten hebben max retries (${MAX_RETRIES_PER_DAY}/dag) bereikt`,
        metadata: { productIds: productIds.slice(0, 20), maxRetriesPerDay: MAX_RETRIES_PER_DAY },
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'All retries exhausted',
        exhaustedCount: productIds.length,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Create a retry job
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .insert({
        type: 'SYNC_TO_WOO',
        state: 'ready',
        tenant_id: tenant.id,
        payload: { productIds: eligibleIds },
      })
      .select('id')
      .single();

    if (jobError) throw jobError;

    // Remove processed pending retries
    await supabase
      .from('pending_product_syncs')
      .delete()
      .in('product_id', eligibleIds)
      .like('reason', 'auto_retry:%');

    // Log to changelog
    await supabase.from('changelog').insert({
      tenant_id: tenant.id,
      event_type: 'AUTO_RETRY_CREATED',
      description: `Auto-retry job aangemaakt voor ${eligibleIds.length} producten (${errorTypes.join(', ')})`,
      metadata: {
        jobId: job.id,
        productCount: eligibleIds.length,
        errorTypes,
        retryCountsSnapshot: Object.fromEntries(
          eligibleIds.slice(0, 10).map(id => [id, retryCountMap.get(id) || 0])
        ),
      },
    });

    console.log(`Created retry job ${job.id} for ${eligibleIds.length} products`);

    // Trigger the job scheduler
    const schedulerUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/job-scheduler`;
    fetch(schedulerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
      },
      body: JSON.stringify({}),
    }).catch(e => console.warn('Failed to trigger scheduler:', e));

    return new Response(JSON.stringify({
      success: true,
      message: `Created retry job for ${eligibleIds.length} products`,
      jobId: job.id,
      productCount: eligibleIds.length,
      errorTypes,
      skippedExhausted: productIds.length - eligibleIds.length,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('Auto-retry error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
