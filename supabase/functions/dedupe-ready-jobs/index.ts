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

    let dryRun = false;
    try {
      const body = await req.json();
      dryRun = body?.dryRun === true;
    } catch { /* no body = default */ }

    const stats = {
      create_jobs_checked: 0,
      create_jobs_removed: 0,
      create_products_already_cached: 0,
      sync_dupes_removed: 0,
      total_removed: 0,
    };

    // ── 1. Remove CREATE_NEW_PRODUCTS jobs for products already in woo_products ──
    const { data: createJobs } = await supabase
      .from('jobs')
      .select('id, payload, tenant_id')
      .eq('type', 'CREATE_NEW_PRODUCTS')
      .eq('state', 'ready')
      .order('created_at', { ascending: true })
      .limit(500);

    if (createJobs && createJobs.length > 0) {
      stats.create_jobs_checked = createJobs.length;

      // Collect all product IDs from payloads
      const allProductIds: string[] = [];
      for (const job of createJobs) {
        const ids = (job.payload as any)?.productIds;
        if (Array.isArray(ids)) {
          allProductIds.push(...ids);
        }
      }

      // Check which products already have woo_products entries
      const uniqueProductIds = [...new Set(allProductIds)];
      const cachedSet = new Set<string>();

      // Batch lookup in chunks of 200
      for (let i = 0; i < uniqueProductIds.length; i += 200) {
        const chunk = uniqueProductIds.slice(i, i + 200);
        const { data: cached } = await supabase
          .from('woo_products')
          .select('product_id')
          .in('product_id', chunk);

        if (cached) {
          for (const row of cached) {
            if (row.product_id) cachedSet.add(row.product_id);
          }
        }
      }

      stats.create_products_already_cached = cachedSet.size;

      // Find jobs where ALL productIds are already cached → safe to remove
      const jobsToRemove: string[] = [];
      for (const job of createJobs) {
        const ids = (job.payload as any)?.productIds;
        if (!Array.isArray(ids) || ids.length === 0) {
          // Empty payload jobs are safe to remove
          jobsToRemove.push(job.id);
          continue;
        }
        const allCached = ids.every((id: string) => cachedSet.has(id));
        if (allCached) {
          jobsToRemove.push(job.id);
        }
      }

      if (jobsToRemove.length > 0 && !dryRun) {
        // Delete in batches of 100
        for (let i = 0; i < jobsToRemove.length; i += 100) {
          const batch = jobsToRemove.slice(i, i + 100);
          await supabase.from('jobs').delete().in('id', batch);
        }
      }
      stats.create_jobs_removed = jobsToRemove.length;
    }

    // ── 2. Deduplicate SYNC_TO_WOO by payload_hash (keep oldest) ──
    const { data: dedupeCount } = await supabase.rpc('dedupe_sync_jobs');
    stats.sync_dupes_removed = dedupeCount || 0;

    stats.total_removed = stats.create_jobs_removed + stats.sync_dupes_removed;

    // ── 3. Log if anything was cleaned ──
    if (stats.total_removed > 0 && !dryRun) {
      // Get any tenant for logging
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id')
        .eq('active', true)
        .limit(1)
        .single();

      if (tenant) {
        await supabase.from('changelog').insert({
          tenant_id: tenant.id,
          event_type: 'BACKLOG_CLEANUP',
          description: `Backlog cleanup: ${stats.create_jobs_removed} redundante CREATE jobs, ${stats.sync_dupes_removed} dubbele SYNC jobs verwijderd`,
          metadata: stats,
        });
      }
    }

    console.log(`[dedupe-ready-jobs] ${dryRun ? 'DRY RUN — ' : ''}Results:`, JSON.stringify(stats));

    return new Response(
      JSON.stringify({ success: true, dryRun, ...stats }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[dedupe-ready-jobs] Error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
