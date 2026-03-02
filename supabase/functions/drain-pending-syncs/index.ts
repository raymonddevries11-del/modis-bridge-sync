import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Batch sizes per scope
const SCOPE_BATCH_SIZES: Record<string, number> = {
  PRICE_STOCK: 50,
  CONTENT: 20,
  TAXONOMY: 20,
  MEDIA: 3,
  VARIATIONS: 5,
  FULL: 3,
};

// Shorter window for price/stock = near real-time
const SCOPE_WINDOWS: Record<string, number> = {
  PRICE_STOCK: 15,    // 15 seconds — near real-time
  CONTENT: 60,
  TAXONOMY: 60,
  MEDIA: 120,
  VARIATIONS: 60,
};

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_WINDOW = 60;

/** Check if a tenant is rate-limited (cooldown active or no tokens) */
async function isTenantThrottled(supabase: any, tenantId: string): Promise<boolean> {
  const { data } = await supabase
    .from('rate_limit_state')
    .select('tokens, cooldown_until')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!data) return false;

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
    // Optional scope filter from body (for targeted drain from pg_net trigger)
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const scopeFilter: string | undefined = body.scope;

    // Load batch config
    const { data: batchConfig } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'batch_sync_config')
      .maybeSingle();

    const config = (batchConfig?.value as Record<string, number>) || {};
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

    // Fetch pending syncs per scope with scope-specific windows
    // If scopeFilter is provided, only drain that scope (for fast pg_net-triggered drains)
    const scopesToDrain = scopeFilter ? [scopeFilter] : Object.keys(SCOPE_WINDOWS).concat(['OTHER']);

    const allPending: Array<{ id: string; product_id: string; tenant_id: string; sync_scope: string; priority: number }> = [];

    for (const scope of scopesToDrain) {
      const windowSeconds = SCOPE_WINDOWS[scope] || DEFAULT_WINDOW;
      const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();

      let query = supabase
        .from('pending_product_syncs')
        .select('id, product_id, tenant_id, sync_scope, priority')
        .eq('status', 'PENDING')
        .lte('last_seen_at', cutoff)
        .order('priority', { ascending: false })
        .order('last_seen_at', { ascending: true })
        .limit(MAX_PRODUCTS_PER_DRAIN);

      if (scope !== 'OTHER') {
        query = query.eq('sync_scope', scope);
      } else {
        // OTHER = anything not in SCOPE_WINDOWS keys
        query = query.not('sync_scope', 'in', `(${Object.keys(SCOPE_WINDOWS).join(',')})`);
      }

      const { data: scopePending, error: fetchErr } = await query;
      if (fetchErr) {
        console.error(`Error fetching ${scope} pending:`, fetchErr);
        continue;
      }
      if (scopePending && scopePending.length > 0) {
        allPending.push(...scopePending);
      }
    }

    if (allPending.length === 0) {
      return new Response(JSON.stringify({ drained: 0, jobs: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Draining ${allPending.length} pending syncs (scope=${scopeFilter || 'ALL'}, slots=${slotsAvailable})`);

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
    const tenantIds = [...new Set(allPending.map(p => p.tenant_id))];
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

    for (const row of allPending) {
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

    console.log(`Drained ${allPending.length} pending → ${jobsCreated} jobs (scope=${scopeFilter || 'ALL'})`);

    return new Response(JSON.stringify({
      drained: allPending.length,
      skipped: skippedCount,
      throttled: throttledTenants.size,
      jobs: jobsCreated,
      groups: groups.size,
      scopeFilter: scopeFilter || 'ALL',
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
