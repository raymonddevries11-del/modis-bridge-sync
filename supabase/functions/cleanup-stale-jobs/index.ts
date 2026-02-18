import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CleanupStats {
  stuck_processing_reset: number;
  stale_ready_purged: number;
  requeued_products: number;
  requeued_job_count: number;
  done_purged: number;
  error_archived: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse options from request body
    let options = {
      requeue: false,           // Re-create a single consolidated job for stale ready products
      staleReadyMinutes: 60,    // Ready jobs older than this are considered stale
      stuckProcessingMinutes: 15,
      purgeDoneDays: 1,
      purgeErrorDays: 7,
      dryRun: false,
    };

    if (req.method === 'POST') {
      try {
        const body = await req.json();
        options = { ...options, ...body };
      } catch { /* use defaults */ }
    }

    console.log('Cleanup-stale-jobs starting with options:', JSON.stringify(options));

    const stats: CleanupStats = {
      stuck_processing_reset: 0,
      stale_ready_purged: 0,
      requeued_products: 0,
      requeued_job_count: 0,
      done_purged: 0,
      error_archived: 0,
    };

    // 1. Reset stuck processing jobs (>N minutes)
    const stuckCutoff = new Date(Date.now() - options.stuckProcessingMinutes * 60 * 1000).toISOString();

    if (!options.dryRun) {
      const { data: stuckJobs } = await supabase
        .from('jobs')
        .update({
          state: 'error',
          error: `Cleanup: stuck in processing > ${options.stuckProcessingMinutes}min`,
          updated_at: new Date().toISOString(),
        })
        .eq('state', 'processing')
        .lt('updated_at', stuckCutoff)
        .select('id');

      stats.stuck_processing_reset = stuckJobs?.length ?? 0;
    }

    // 2. Handle stale ready jobs
    const staleCutoff = new Date(Date.now() - options.staleReadyMinutes * 60 * 1000).toISOString();

    const { data: staleReadyJobs } = await supabase
      .from('jobs')
      .select('id, type, payload, tenant_id')
      .eq('state', 'ready')
      .lt('created_at', staleCutoff);

    const staleJobs = staleReadyJobs ?? [];
    console.log(`Found ${staleJobs.length} stale ready jobs (older than ${options.staleReadyMinutes}min)`);

    if (staleJobs.length > 0 && options.requeue) {
      // Collect all product IDs by type+tenant for consolidated requeue
      const buckets = new Map<string, { type: string; tenantId: string; productIds: Set<string> }>();

      for (const job of staleJobs) {
        const ids = (job.payload as any)?.productIds;
        if (!Array.isArray(ids) || ids.length === 0) continue;

        const key = `${job.type}__${job.tenant_id}`;
        if (!buckets.has(key)) {
          buckets.set(key, { type: job.type, tenantId: job.tenant_id, productIds: new Set() });
        }
        const bucket = buckets.get(key)!;
        for (const id of ids) bucket.productIds.add(id);
      }

      // For each bucket, check which products still actually need processing
      for (const [, bucket] of buckets) {
        let validProductIds = [...bucket.productIds];

        if (bucket.type === 'CREATE_NEW_PRODUCTS') {
          // Check woo_products cache — only requeue products not yet in WooCommerce
          const { data: wooProducts } = await supabase
            .from('woo_products')
            .select('product_id')
            .in('product_id', validProductIds);

          const alreadyInWoo = new Set((wooProducts ?? []).map((p: any) => p.product_id));
          validProductIds = validProductIds.filter(id => !alreadyInWoo.has(id));
        }

        if (validProductIds.length > 0 && !options.dryRun) {
          // Create consolidated jobs in batches of 25
          const BATCH = bucket.type === 'CREATE_NEW_PRODUCTS' ? 3 : 25;
          for (let i = 0; i < validProductIds.length; i += BATCH) {
            const batch = validProductIds.slice(i, i + BATCH);
            await supabase.from('jobs').insert({
              type: bucket.type,
              state: 'ready',
              payload: { productIds: batch },
              tenant_id: bucket.tenantId,
            });
            stats.requeued_job_count++;
          }
          stats.requeued_products += validProductIds.length;
        }

        console.log(`Bucket ${bucket.type}/${bucket.tenantId}: ${bucket.productIds.size} total → ${validProductIds.length} still valid`);
      }
    }

    // Delete the stale ready jobs
    if (staleJobs.length > 0 && !options.dryRun) {
      const staleIds = staleJobs.map(j => j.id);
      // Delete in batches of 100
      for (let i = 0; i < staleIds.length; i += 100) {
        const batch = staleIds.slice(i, i + 100);
        await supabase.from('jobs').delete().in('id', batch);
      }
      stats.stale_ready_purged = staleJobs.length;
    }

    // 3. Purge old done jobs
    const doneCutoff = new Date(Date.now() - options.purgeDoneDays * 24 * 60 * 60 * 1000).toISOString();
    if (!options.dryRun) {
      const { data: doneJobs } = await supabase
        .from('jobs')
        .delete()
        .eq('state', 'done')
        .lt('updated_at', doneCutoff)
        .select('id');

      stats.done_purged = doneJobs?.length ?? 0;
    }

    // 4. Purge old error jobs
    const errorCutoff = new Date(Date.now() - options.purgeErrorDays * 24 * 60 * 60 * 1000).toISOString();
    if (!options.dryRun) {
      const { data: errorJobs } = await supabase
        .from('jobs')
        .delete()
        .eq('state', 'error')
        .lt('updated_at', errorCutoff)
        .select('id');

      stats.error_archived = errorJobs?.length ?? 0;
    }

    // Log to changelog
    if (!options.dryRun) {
      const { data: tenants } = await supabase
        .from('tenants')
        .select('id')
        .eq('active', true)
        .limit(1);

      if (tenants?.[0]) {
        await supabase.from('changelog').insert({
          tenant_id: tenants[0].id,
          event_type: 'HOUSEKEEP_JOBS',
          description: `Cleanup: ${stats.stale_ready_purged} stale ready verwijderd, ${stats.stuck_processing_reset} stuck gereset, ${stats.requeued_products} producten opnieuw ingepland, ${stats.done_purged} done + ${stats.error_archived} error opgeruimd`,
          metadata: stats,
        });
      }
    }

    console.log('Cleanup complete:', JSON.stringify(stats));

    return new Response(
      JSON.stringify({ success: true, dryRun: options.dryRun, stats }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in cleanup-stale-jobs:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
