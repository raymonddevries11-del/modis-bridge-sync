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
    // Load batch config (default: 50 products per job, 60s window)
    const { data: batchConfig } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'batch_sync_config')
      .maybeSingle();

    const config = (batchConfig?.value as Record<string, number>) || {};
    const BATCH_SIZE = config.batch_size || 50;
    const WINDOW_SECONDS = config.window_seconds || 60;

    // Only drain items older than the batch window (debounce)
    const cutoff = new Date(Date.now() - WINDOW_SECONDS * 1000).toISOString();

    // Fetch all pending syncs older than the window
    const { data: pending, error: fetchErr } = await supabase
      .from('pending_product_syncs')
      .select('product_id, tenant_id, reason')
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(500);

    if (fetchErr) throw fetchErr;

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ drained: 0, jobs: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Draining ${pending.length} pending syncs (window=${WINDOW_SECONDS}s, batch=${BATCH_SIZE})`);

    // Group by tenant
    const byTenant = new Map<string, Set<string>>();
    for (const row of pending) {
      const tid = row.tenant_id;
      if (!byTenant.has(tid)) byTenant.set(tid, new Set());
      byTenant.get(tid)!.add(row.product_id);
    }

    let jobsCreated = 0;

    for (const [tenantId, productIds] of byTenant) {
      const ids = Array.from(productIds);

      // Split into batches
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const { error: jobErr } = await supabase
          .from('jobs')
          .insert({
            type: 'SYNC_TO_WOO',
            state: 'ready',
            payload: { productIds: batch },
            tenant_id: tenantId,
          });

        if (jobErr) {
          // Likely duplicate via payload_hash — skip silently
          if (jobErr.code === '23505') {
            console.log(`Skipped duplicate job for batch of ${batch.length}`);
          } else {
            console.error('Error creating job:', jobErr);
          }
        } else {
          jobsCreated++;
        }
      }
    }

    // Delete drained rows
    const productIdsToDelete = pending.map(p => p.product_id);
    // Delete in chunks of 200 to avoid query size limits
    for (let i = 0; i < productIdsToDelete.length; i += 200) {
      const chunk = productIdsToDelete.slice(i, i + 200);
      await supabase
        .from('pending_product_syncs')
        .delete()
        .in('product_id', chunk)
        .lte('created_at', cutoff);
    }

    console.log(`Drained ${pending.length} pending → ${jobsCreated} jobs`);

    return new Response(JSON.stringify({
      drained: pending.length,
      jobs: jobsCreated,
      tenants: byTenant.size,
      batchSize: BATCH_SIZE,
      windowSeconds: WINDOW_SECONDS,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('drain-pending-syncs error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
