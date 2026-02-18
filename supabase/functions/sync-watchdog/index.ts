import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WatchdogConfig {
  // Thresholds
  max_jobs_per_hour: number;       // alert if more jobs created in 1h (default 30)
  max_ready_jobs: number;          // alert if queue depth exceeds this (default 20)
  max_pending_products: number;    // alert if pending_product_syncs exceeds this (default 500)
  // Auto-fix limits
  auto_adjust_enabled: boolean;    // whether watchdog can auto-adjust config (default true)
  min_batch_size: number;          // floor for batch_size auto-adjustment (default 25)
  max_batch_size: number;          // ceiling for batch_size (default 100)
  min_queue_limit: number;         // floor for max_queue_size (default 5)
  max_queue_limit: number;         // ceiling for max_queue_size (default 50)
}

const DEFAULTS: WatchdogConfig = {
  max_jobs_per_hour: 30,
  max_ready_jobs: 20,
  max_pending_products: 500,
  auto_adjust_enabled: true,
  min_batch_size: 25,
  max_batch_size: 100,
  min_queue_limit: 5,
  max_queue_limit: 50,
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
    // Load watchdog config
    const { data: wdConfigRow } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'sync_watchdog_config')
      .maybeSingle();
    const wdConfig: WatchdogConfig = { ...DEFAULTS, ...(wdConfigRow?.value as Partial<WatchdogConfig> || {}) };

    // Load current batch sync config
    const { data: batchConfigRow } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'batch_sync_config')
      .maybeSingle();
    const batchConfig = (batchConfigRow?.value as Record<string, number>) || {};
    const currentBatchSize = batchConfig.batch_size || 50;
    const currentMaxQueue = batchConfig.max_queue_size || 10;
    const currentWindow = batchConfig.window_seconds || 60;
    const currentMaxDrain = batchConfig.max_products_per_drain || 200;

    // --- Gather metrics ---
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

    // Jobs created in the last hour
    const { count: jobsLastHour } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .gte('created_at', oneHourAgo);

    // Current queue depth (ready + processing)
    const { count: activeJobs } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .in('state', ['ready', 'processing']);

    // Pending product syncs backlog
    const { count: pendingProducts } = await supabase
      .from('pending_product_syncs')
      .select('product_id', { count: 'exact', head: true });

    // Error jobs in last hour
    const { count: errorJobsLastHour } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'error')
      .gte('created_at', oneHourAgo);

    const metrics = {
      jobs_last_hour: jobsLastHour || 0,
      active_jobs: activeJobs || 0,
      pending_products: pendingProducts || 0,
      error_jobs_last_hour: errorJobsLastHour || 0,
    };

    console.log(`Watchdog metrics:`, JSON.stringify(metrics));

    // --- Evaluate alerts ---
    const alerts: string[] = [];
    const adjustments: Array<{ field: string; from: number; to: number; reason: string }> = [];

    const excessiveCreation = metrics.jobs_last_hour > wdConfig.max_jobs_per_hour;
    const queueOverflow = metrics.active_jobs > wdConfig.max_ready_jobs;
    const pendingBacklog = metrics.pending_products > wdConfig.max_pending_products;
    const highErrorRate = metrics.error_jobs_last_hour > 10;

    if (excessiveCreation) alerts.push(`${metrics.jobs_last_hour} jobs aangemaakt in het afgelopen uur (limiet: ${wdConfig.max_jobs_per_hour})`);
    if (queueOverflow) alerts.push(`${metrics.active_jobs} actieve jobs in wachtrij (limiet: ${wdConfig.max_ready_jobs})`);
    if (pendingBacklog) alerts.push(`${metrics.pending_products} producten wachten op sync (limiet: ${wdConfig.max_pending_products})`);
    if (highErrorRate) alerts.push(`${metrics.error_jobs_last_hour} fouten in het afgelopen uur`);

    // --- Auto-adjust if enabled ---
    let newBatchConfig = { ...batchConfig };
    let configChanged = false;

    if (wdConfig.auto_adjust_enabled && (excessiveCreation || queueOverflow)) {
      // Increase batch size to reduce number of jobs
      if (excessiveCreation && currentBatchSize < wdConfig.max_batch_size) {
        const newSize = Math.min(currentBatchSize * 2, wdConfig.max_batch_size);
        adjustments.push({ field: 'batch_size', from: currentBatchSize, to: newSize, reason: 'Te veel jobs per uur' });
        newBatchConfig.batch_size = newSize;
        configChanged = true;
      }

      // Decrease max_queue_size to throttle creation
      if (queueOverflow && currentMaxQueue > wdConfig.min_queue_limit) {
        const newLimit = Math.max(Math.floor(currentMaxQueue * 0.7), wdConfig.min_queue_limit);
        adjustments.push({ field: 'max_queue_size', from: currentMaxQueue, to: newLimit, reason: 'Queue overflow' });
        newBatchConfig.max_queue_size = newLimit;
        configChanged = true;
      }
    }

    // If things are calm, gradually restore defaults
    if (wdConfig.auto_adjust_enabled && !excessiveCreation && !queueOverflow && !pendingBacklog && !highErrorRate) {
      // Slowly bring batch_size back toward 50 if it was increased
      if (currentBatchSize > 50) {
        const restored = Math.max(Math.floor(currentBatchSize * 0.75), 50);
        if (restored !== currentBatchSize) {
          adjustments.push({ field: 'batch_size', from: currentBatchSize, to: restored, reason: 'Queue stabiel — batch_size verlaagd' });
          newBatchConfig.batch_size = restored;
          configChanged = true;
        }
      }
      // Restore max_queue_size toward 10 if it was decreased
      if (currentMaxQueue < 10) {
        const restored = Math.min(currentMaxQueue + 2, 10);
        adjustments.push({ field: 'max_queue_size', from: currentMaxQueue, to: restored, reason: 'Queue stabiel — limiet verhoogd' });
        newBatchConfig.max_queue_size = restored;
        configChanged = true;
      }
    }

    // Apply config changes
    if (configChanged) {
      await supabase.from('config').upsert({
        key: 'batch_sync_config',
        value: newBatchConfig,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      console.log(`Watchdog auto-adjusted config:`, JSON.stringify(adjustments));
    }

    // Log to changelog if there are alerts
    if (alerts.length > 0) {
      // Get first tenant for changelog
      const { data: tenant } = await supabase.from('tenants').select('id').eq('active', true).limit(1).single();
      if (tenant) {
        await supabase.from('changelog').insert({
          tenant_id: tenant.id,
          event_type: 'SYNC_WATCHDOG',
          description: `Watchdog: ${alerts.length} waarschuwing${alerts.length > 1 ? 'en' : ''} — ${adjustments.length > 0 ? `${adjustments.length} auto-aanpassing${adjustments.length > 1 ? 'en' : ''}` : 'geen aanpassingen'}`,
          metadata: { metrics, alerts, adjustments, config_before: batchConfig, config_after: configChanged ? newBatchConfig : null },
        });
      }
    }

    // Save watchdog state for UI
    await supabase.from('config').upsert({
      key: 'sync_watchdog_state',
      value: {
        last_run: new Date().toISOString(),
        metrics,
        alerts,
        adjustments,
        config_changed: configChanged,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    return new Response(JSON.stringify({
      success: true,
      metrics,
      alerts,
      adjustments,
      configChanged,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Sync watchdog error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
