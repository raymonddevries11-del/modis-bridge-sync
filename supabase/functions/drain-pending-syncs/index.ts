import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Batch sizes per scope
const SCOPE_BATCH_SIZES: Record<string, number> = {
  PRICE_STOCK: 50,
  CONTENT: 25,
  TAXONOMY: 25,
  MEDIA: 10,
  VARIATIONS: 10,
};

const DEFAULT_BATCH_SIZE = 50;

/** Check if a tenant is rate-limited (cooldown active or no tokens) */
async function isTenantThrottled(supabase: any, tenantId: string): Promise<boolean> {
  const { data } = await supabase
    .from('rate_limit_state')
    .select('tokens, cooldown_until')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!data) return false; // no rate limit record = not throttled

  const now = new Date();
  if (data.cooldown_until && new Date(data.cooldown_until) > now) {
    return true;
  }
  if (data.tokens <= 0) {
    return true;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    // Load batch config
    const { data: batchConfig } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'batch_sync_config')
      .maybeSingle();

    const config = (batchConfig?.value as Record<string, number>) || {};
    const WINDOW_SECONDS = config.window_seconds || 60;
    const MAX_PRODUCTS_PER_DRAIN = config.max_products_per_drain || 200;
    const MAX_QUEUE_SIZE = config.max_queue_size || 10;

    // Check current queue depth
    const { count: currentQueueSize } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .in('state', ['ready', 'processing']);

    if ((currentQueueSize || 0) >= MAX_QUEUE_SIZE) {
      console.log(`Queue already has ${currentQueueSize} active jobs (max ${MAX_QUEUE_SIZE}) — skipping drain`);
      return new Response(JSON.stringify({ drained: 0, jobs: 0, skipped: true, reason: 'queue_full', currentQueueSize }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const slotsAvailable = MAX_QUEUE_SIZE - (currentQueueSize || 0);

    // Only drain items older than the batch window (debounce)
    const cutoff = new Date(Date.now() - WINDOW_SECONDS * 1000).toISOString();

    // Fetch pending syncs ordered by priority DESC (highest first), then oldest first
    const { data: pending, error: fetchErr } = await supabase
      .from('pending_product_syncs')
      .select('id, product_id, tenant_id, sync_scope, priority')
      .eq('status', 'PENDING')
      .lte('last_seen_at', cutoff)
      .order('priority', { ascending: false })
      .order('last_seen_at', { ascending: true })
      .limit(MAX_PRODUCTS_PER_DRAIN);

    if (fetchErr) throw fetchErr;

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ drained: 0, jobs: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Draining ${pending.length} pending syncs (window=${WINDOW_SECONDS}s, slots=${slotsAvailable})`);

    // Build set of product IDs already in queued jobs to avoid duplicates
    const alreadyQueued = new Set<string>();
    const { data: existingJobs } = await supabase
      .from('jobs')
      .select('payload')
      .eq('type', 'SYNC_TO_WOO')
      .in('state', ['ready', 'processing']);

    if (existingJobs) {
      for (const job of existingJobs) {
        const ids = (job.payload as any)?.productIds;
        if (Array.isArray(ids)) {
          for (const id of ids) alreadyQueued.add(id);
        }
      }
    }

    // Check throttled tenants
    const tenantIds = [...new Set(pending.map(p => p.tenant_id))];
    const throttledTenants = new Set<string>();
    for (const tid of tenantIds) {
      if (await isTenantThrottled(supabase, tid)) {
        throttledTenants.add(tid);
      }
    }

    if (throttledTenants.size > 0) {
      console.log(`Rate-limited tenants: ${throttledTenants.size} — deferring their items`);
    }

    // Group by (tenant_id, sync_scope), filtering out already-queued and throttled
    const groupKey = (tenantId: string, scope: string) => `${tenantId}::${scope}`;
    const groups = new Map<string, { tenantId: string; scope: string; productIds: string[]; priority: number }>();
    let skippedCount = 0;
    const pendingIdsToDelete: string[] = [];

    for (const row of pending) {
      if (alreadyQueued.has(row.product_id)) {
        skippedCount++;
        pendingIdsToDelete.push(row.id);
        continue;
      }
      if (throttledTenants.has(row.tenant_id)) {
        continue; // leave in queue for next drain
      }

      const key = groupKey(row.tenant_id, row.sync_scope || 'PRICE_STOCK');
      if (!groups.has(key)) {
        groups.set(key, {
          tenantId: row.tenant_id,
          scope: row.sync_scope || 'PRICE_STOCK',
          productIds: [],
          priority: row.priority || 50,
        });
      }
      const group = groups.get(key)!;
      group.productIds.push(row.product_id);
      group.priority = Math.max(group.priority, row.priority || 50);
      pendingIdsToDelete.push(row.id);
    }

    if (skippedCount > 0) {
      console.log(`Dedup: skipped ${skippedCount} products already in queued jobs`);
    }

    let jobsCreated = 0;

    for (const [, group] of groups) {
      const batchSize = SCOPE_BATCH_SIZES[group.scope] || DEFAULT_BATCH_SIZE;
      const ids = group.productIds;

      for (let i = 0; i < ids.length; i += batchSize) {
        if (jobsCreated >= slotsAvailable) {
          console.log(`Reached queue slot limit (${slotsAvailable}), deferring remaining products`);
          break;
        }

        const batch = ids.slice(i, i + batchSize);
        const { error: jobErr } = await supabase
          .from('jobs')
          .insert({
            type: 'SYNC_TO_WOO',
            state: 'ready',
            payload: { productIds: batch, syncScope: group.scope },
            tenant_id: group.tenantId,
            scope: group.scope,
            priority: group.priority,
          });

        if (jobErr) {
          if (jobErr.code === '23505') {
            console.log(`Skipped duplicate job for ${group.scope} batch of ${batch.length}`);
          } else {
            console.error('Error creating job:', jobErr);
          }
        } else {
          jobsCreated++;
        }
      }
    }

    // Delete drained rows (by ID for precision)
    for (let i = 0; i < pendingIdsToDelete.length; i += 200) {
      const chunk = pendingIdsToDelete.slice(i, i + 200);
      await supabase
        .from('pending_product_syncs')
        .delete()
        .in('id', chunk);
    }

    console.log(`Drained ${pending.length} pending → ${jobsCreated} jobs`);

    return new Response(JSON.stringify({
      drained: pending.length,
      skipped: skippedCount,
      throttled: throttledTenants.size,
      jobs: jobsCreated,
      groups: groups.size,
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
