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
    const pimProducts: Array<{ id: string; sku: string; updated_at: string; woocommerce_product_id: number | null }> = [];
    const PAGE_SIZE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('products')
        .select('id, sku, updated_at, woocommerce_product_id')
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
    const mismatched: Array<{ sku: string; product_id: string; cache_woo_id: number; product_woo_id: number }> = [];
    const duplicateLinks: Array<{ product_id: string; woo_ids: number[]; kept_woo_id: number }> = [];

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Find uncached: PIM products with no matching woo_products entry
    for (const [sku] of pimBySku) {
      if (!wooBySku.has(sku)) {
        uncached.push(sku);
      }
    }

    // ── 4a. Detect duplicate woo_products linking to the same product_id ──
    const wooByProductId = new Map<string, typeof wooCache>();
    for (const woo of (wooCache || [])) {
      if (!woo.product_id) continue;
      const existing = wooByProductId.get(woo.product_id);
      if (existing) {
        existing.push(woo);
      } else {
        wooByProductId.set(woo.product_id, [woo]);
      }
    }

    const duplicateProductIds: string[] = [];
    for (const [productId, entries] of wooByProductId) {
      if (entries.length <= 1) continue;
      // Multiple cache entries for the same PIM product — keep the one matching woocommerce_product_id
      const pim = pimById.get(productId);
      // Sort: prefer entry matching products.woocommerce_product_id, then most recently pushed
      entries.sort((a, b) => {
        const aMatch = pim && pim.woocommerce_product_id === a.woo_id ? 1 : 0;
        const bMatch = pim && pim.woocommerce_product_id === b.woo_id ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return (b.last_pushed_at || '').localeCompare(a.last_pushed_at || '');
      });
      const kept = entries[0];
      const dupeIds = entries.slice(1).map(e => e.id);
      duplicateLinks.push({
        product_id: productId,
        woo_ids: entries.map(e => e.woo_id),
        kept_woo_id: kept.woo_id,
      });
      duplicateProductIds.push(...dupeIds);
      console.warn(`Duplicate cache entries for product ${productId}: woo_ids=[${entries.map(e => e.woo_id).join(',')}] — keeping ${kept.woo_id}`);
    }

    // ── 4b. Detect mismatched woocommerce_product_id ──
    // Use the woocommerce_product_id already fetched in step 2
    const expectedWooIdMap = new Map(
      pimProducts.filter(p => p.woocommerce_product_id != null).map(p => [p.id, p.woocommerce_product_id!])
    );
    const mismatchFixes: Array<{ product_id: string; correct_woo_id: number }> = [];

    for (const [productId, entries] of wooByProductId) {
      if (entries.length === 0) continue;
      const expectedWooId = expectedWooIdMap.get(productId);
      if (!expectedWooId) continue;
      
      // Check if any cache entry matches the expected woo_id
      const matching = entries.find(e => e.woo_id === expectedWooId);
      if (!matching) {
        // products.woocommerce_product_id doesn't match ANY cache entry
        const pim = pimBySku.get(entries[0].sku || '');
        mismatched.push({
          sku: entries[0].sku || 'unknown',
          product_id: productId,
          cache_woo_id: entries[0].woo_id,
          product_woo_id: expectedWooId,
        });
        // Fix: update products.woocommerce_product_id to match the most recently pushed cache entry
        const bestCache = entries.sort((a, b) => (b.last_pushed_at || '').localeCompare(a.last_pushed_at || ''))[0];
        mismatchFixes.push({ product_id: productId, correct_woo_id: bestCache.woo_id });
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

    console.log(`Reconciliation findings: ${uncached.length} uncached, ${orphaned.length} orphaned, ${stale.length} stale, ${mismatched.length} mismatched, ${duplicateLinks.length} duplicate links`);

    let orphansRemoved = 0;
    let syncsQueued = 0;
    let duplicatesRemoved = 0;
    let mismatchesFixed = 0;

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

      // ── 5a. Remove duplicate woo_products entries (keep best match) ──
      if (duplicateProductIds.length > 0) {
        const { error: dupDelErr } = await supabase
          .from('woo_products')
          .delete()
          .in('id', duplicateProductIds);

        if (dupDelErr) {
          console.error(`Failed to remove duplicate cache entries: ${dupDelErr.message}`);
        } else {
          duplicatesRemoved = duplicateProductIds.length;
          console.log(`Removed ${duplicatesRemoved} duplicate woo_products entries`);
        }
      }

      // ── 5b. Fix mismatched woocommerce_product_id via WooCommerce API SKU lookup ──
      if (mismatchFixes.length > 0) {
        // Fetch WooCommerce credentials for API lookups
        const { data: tenantConfig } = await supabase
          .from('tenant_config')
          .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
          .eq('tenant_id', tenantId)
          .single();

        for (const fix of mismatchFixes) {
          const pim = pimById.get(fix.product_id);
          const sku = pim?.sku;
          let resolvedWooId = fix.correct_woo_id; // fallback to cache-based fix

          // Try WooCommerce API lookup by SKU for authoritative answer
          if (tenantConfig && sku) {
            try {
              const auth = btoa(`${tenantConfig.woocommerce_consumer_key}:${tenantConfig.woocommerce_consumer_secret}`);
              const resp = await fetch(
                `${tenantConfig.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`,
                {
                  headers: {
                    'Authorization': `Basic ${auth}`,
                    'User-Agent': 'PIM-Reconciler/1.0',
                    'Accept': 'application/json',
                  },
                },
              );
              if (resp.ok) {
                const products = await resp.json();
                if (products.length > 0) {
                  resolvedWooId = products[0].id;
                  console.log(`API lookup for SKU ${sku}: woo_id=${resolvedWooId}`);
                }
              } else {
                console.warn(`API lookup failed for SKU ${sku}: ${resp.status}`);
              }
            } catch (e) {
              console.warn(`API lookup error for SKU ${sku}: ${e}`);
            }
          }

          // Update products.woocommerce_product_id
          const { error: fixErr } = await supabase
            .from('products')
            .update({ woocommerce_product_id: resolvedWooId })
            .eq('id', fix.product_id);

          // Also update woo_products cache entry to match
          if (!fixErr) {
            mismatchesFixed++;
            console.log(`Fixed woocommerce_product_id for product ${fix.product_id} (SKU ${sku}): → ${resolvedWooId}`);

            // Update the cache entry's woo_id if it differs
            const cacheEntry = wooByProductId.get(fix.product_id)?.[0];
            if (cacheEntry && cacheEntry.woo_id !== resolvedWooId) {
              await supabase
                .from('woo_products')
                .update({ woo_id: resolvedWooId })
                .eq('id', cacheEntry.id);
              console.log(`Updated woo_products cache woo_id for ${cacheEntry.id}: → ${resolvedWooId}`);
            }
          } else {
            console.error(`Failed to fix mismatch for ${fix.product_id}: ${fixErr.message}`);
          }
        }
      }

      // ── 6. Queue uncached products for sync (max 50 to avoid queue flooding) ──
      const { count: queueDepth } = await supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .in('state', ['ready', 'processing'])
        .in('type', ['SYNC_TO_WOO', 'CREATE_NEW_PRODUCTS']);

      const MAX_QUEUE_ADDITIONS = 50;
      const availableSlots = Math.max(0, MAX_QUEUE_ADDITIONS - (queueDepth || 0));

      if (uncached.length > 0 && availableSlots > 0) {
        const uncachedProducts = uncached
          .slice(0, availableSlots)
          .map(sku => pimBySku.get(sku)!)
          .filter(Boolean);

        if (uncachedProducts.length > 0) {
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

      // ── 7. Queue stale products for re-sync ──
      if (stale.length > 0) {
        const staleProducts = stale
          .slice(0, 100)
          .map(sku => pimBySku.get(sku)!)
          .filter(Boolean);

        for (const p of staleProducts) {
          await supabase.from('pending_product_syncs').upsert({
            product_id: p.id,
            tenant_id: tenantId,
            sync_scope: 'CONTENT',
            priority: 30,
            status: 'PENDING',
            reason: 'reconciliation_stale',
            last_seen_at: new Date().toISOString(),
          }, { onConflict: 'tenant_id,product_id,sync_scope' });
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
      mismatched: mismatched.length,
      duplicate_links: duplicateLinks.length,
      orphans_removed: orphansRemoved,
      duplicates_removed: duplicatesRemoved,
      mismatches_fixed: mismatchesFixed,
      syncs_queued: syncsQueued,
      stale_queued: Math.min(stale.length, 100),
      dry_run: dryRun,
      sample_uncached: uncached.slice(0, 10),
      sample_orphaned: orphaned.slice(0, 10),
      sample_stale: stale.slice(0, 10),
      sample_mismatched: mismatched.slice(0, 10),
      sample_duplicate_links: duplicateLinks.slice(0, 10),
    };

    if (!dryRun) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'PRODUCT_CACHE_RECONCILIATION',
        description: `Dagelijkse reconciliatie: ${uncached.length} niet gecacht, ${orphaned.length} verweesd, ${stale.length} verouderd, ${mismatched.length} mismatched, ${duplicateLinks.length} duplicaten. Opgeschoond: ${orphansRemoved} orphans, ${duplicatesRemoved} duplicaten, ${mismatchesFixed} mismatches.`,
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
