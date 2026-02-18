import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Daily product data reconciliation between PIM (products table) and WooCommerce (woo_products cache).
 *
 * Steps:
 * 1. Identify PIM products missing from woo_products cache ("uncached")
 * 2. Identify woo_products entries whose PIM product no longer exists ("orphaned")
 * 3. Identify stale cache entries (not pushed in >7 days despite PIM updates)
 * 4. Clean up orphaned entries
 * 5. Queue missing products for sync
 * 6. Log a reconciliation report to changelog
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const dryRun = body.dry_run === true;

    console.log(`Product cache reconciliation starting (dry_run=${dryRun})`);

    // ── 1. Get active tenant ──
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('id, name')
      .eq('active', true)
      .single();

    if (tenantErr || !tenant) {
      throw new Error(`No active tenant found: ${tenantErr?.message}`);
    }

    const tenantId = tenant.id;

    // ── 2. Fetch all PIM product SKUs (paginated) ──
    const pimProducts: Array<{ id: string; sku: string; updated_at: string }> = [];
    const PAGE_SIZE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('products')
        .select('id, sku, updated_at')
        .eq('tenant_id', tenantId)
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(`Failed to fetch PIM products: ${error.message}`);
      if (!data || data.length === 0) break;
      pimProducts.push(...data);
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (pimProducts.length === 0) {
      return new Response(JSON.stringify({ success: true, message: 'No PIM products found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const pimBySku = new Map(pimProducts.map(p => [p.sku, p]));
    const pimById = new Map(pimProducts.map(p => [p.id, p]));

    // ── 3. Fetch all woo_products cache entries (paginated) ──
    const wooCache: Array<{ id: string; sku: string | null; product_id: string | null; woo_id: number; last_pushed_at: string | null; updated_at: string }> = [];
    offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('woo_products')
        .select('id, sku, product_id, woo_id, last_pushed_at, updated_at')
        .eq('tenant_id', tenantId)
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(`Failed to fetch woo_products: ${error.message}`);
      if (!data || data.length === 0) break;
      wooCache.push(...data);
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    const wooBySku = new Map((wooCache || []).map(w => [w.sku, w]));

    // ── 4. Identify discrepancies ──
    const uncached: string[] = [];       // PIM products not in woo_products
    const orphaned: string[] = [];       // woo_products entries with no PIM product
    const stale: string[] = [];          // woo_products not pushed in >7 days despite PIM update

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Find uncached: PIM products with no matching woo_products entry
    for (const [sku] of pimBySku) {
      if (!wooBySku.has(sku)) {
        uncached.push(sku);
      }
    }

    // Find orphaned & stale
    for (const woo of (wooCache || [])) {
      // Orphaned: woo_products entry whose product_id doesn't exist in PIM
      if (woo.product_id && !pimById.has(woo.product_id)) {
        orphaned.push(woo.sku || `woo_id:${woo.woo_id}`);
        continue;
      }

      // Stale: last_pushed_at is older than 7 days AND PIM product was updated since last push
      if (woo.product_id && woo.last_pushed_at && woo.last_pushed_at < sevenDaysAgo) {
        const pim = pimById.get(woo.product_id);
        if (pim && pim.updated_at > woo.last_pushed_at) {
          stale.push(woo.sku || `woo_id:${woo.woo_id}`);
        }
      }
    }

    console.log(`Reconciliation findings: ${uncached.length} uncached, ${orphaned.length} orphaned, ${stale.length} stale`);

    let orphansRemoved = 0;
    let syncsQueued = 0;

    if (!dryRun) {
      // ── 5. Remove orphaned woo_products entries ──
      if (orphaned.length > 0) {
        const orphanWooIds = (wooCache || [])
          .filter(w => w.product_id && !pimById.has(w.product_id))
          .map(w => w.id);

        if (orphanWooIds.length > 0) {
          const { error: delErr } = await supabase
            .from('woo_products')
            .delete()
            .in('id', orphanWooIds);

          if (delErr) {
            console.error(`Failed to remove orphans: ${delErr.message}`);
          } else {
            orphansRemoved = orphanWooIds.length;
            console.log(`Removed ${orphansRemoved} orphaned woo_products entries`);
          }
        }
      }

      // ── 6. Queue uncached products for sync (max 50 to avoid queue flooding) ──
      // Check existing queue depth first
      const { count: queueDepth } = await supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .in('state', ['ready', 'processing'])
        .in('type', ['SYNC_TO_WOO', 'CREATE_NEW_PRODUCTS']);

      const MAX_QUEUE_ADDITIONS = 50;
      const availableSlots = Math.max(0, MAX_QUEUE_ADDITIONS - (queueDepth || 0));

      if (uncached.length > 0 && availableSlots > 0) {
        // Get product IDs for uncached SKUs
        const uncachedProducts = uncached
          .slice(0, availableSlots)
          .map(sku => pimBySku.get(sku)!)
          .filter(Boolean);

        if (uncachedProducts.length > 0) {
          // Check which ones are already queued
          const { data: existingJobs } = await supabase
            .from('jobs')
            .select('payload')
            .in('state', ['ready', 'processing'])
            .in('type', ['SYNC_TO_WOO', 'CREATE_NEW_PRODUCTS']);

          const alreadyQueued = new Set<string>();
          for (const job of existingJobs || []) {
            const ids = (job.payload as any)?.productIds;
            if (Array.isArray(ids)) ids.forEach((id: string) => alreadyQueued.add(id));
          }

          const toQueue = uncachedProducts.filter(p => !alreadyQueued.has(p.id));

          if (toQueue.length > 0) {
            // Batch into groups of 5
            for (let i = 0; i < toQueue.length; i += 5) {
              const batch = toQueue.slice(i, i + 5);
              const { error: jobErr } = await supabase.from('jobs').insert({
                type: 'SYNC_TO_WOO',
                state: 'ready',
                tenant_id: tenantId,
                payload: { productIds: batch.map(p => p.id), source: 'reconciliation' },
              });
              if (!jobErr) syncsQueued += batch.length;
            }
            console.log(`Queued ${syncsQueued} uncached products for sync`);
          }
        }
      }

      // ── 7. Queue stale products for re-sync (via pending_product_syncs for controlled draining) ──
      if (stale.length > 0) {
        const staleProducts = stale
          .slice(0, 100) // Cap at 100
          .map(sku => pimBySku.get(sku)!)
          .filter(Boolean);

        for (const p of staleProducts) {
          await supabase.from('pending_product_syncs').upsert({
            product_id: p.id,
            tenant_id: tenantId,
            reason: 'reconciliation_stale',
            created_at: new Date().toISOString(),
          }, { onConflict: 'product_id,reason' });
        }
        console.log(`Queued ${staleProducts.length} stale products via pending_product_syncs`);
      }
    }

    // ── 8. Log reconciliation report ──
    const report = {
      total_pim: pimProducts.length,
      total_cached: (wooCache || []).length,
      uncached: uncached.length,
      orphaned: orphaned.length,
      stale: stale.length,
      orphans_removed: orphansRemoved,
      syncs_queued: syncsQueued,
      stale_queued: Math.min(stale.length, 100),
      dry_run: dryRun,
      sample_uncached: uncached.slice(0, 10),
      sample_orphaned: orphaned.slice(0, 10),
      sample_stale: stale.slice(0, 10),
    };

    if (!dryRun) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'PRODUCT_CACHE_RECONCILIATION',
        description: `Dagelijkse reconciliatie: ${uncached.length} niet gecacht, ${orphaned.length} verweesd, ${stale.length} verouderd. ${orphansRemoved} verwijderd, ${syncsQueued} ingepland.`,
        metadata: report,
      });
    }

    console.log('Reconciliation complete:', JSON.stringify(report));

    return new Response(JSON.stringify({ success: true, ...report }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Reconciliation error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
