import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Proactive SKU conflict recovery: before queuing products for creation,
 * check WooCommerce for existing SKUs and link them automatically.
 */
async function resolveExistingSkus(
  supabase: any,
  products: Array<{ id: string; sku: string; title: string; tenant_id: string }>,
  tenantId: string,
): Promise<{ resolved: string[]; remaining: typeof products }> {
  const resolved: string[] = [];

  // Fetch WooCommerce credentials
  const { data: config } = await supabase
    .from('tenant_config')
    .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
    .eq('tenant_id', tenantId)
    .single();

  if (!config) {
    console.warn('No tenant config found — skipping proactive SKU check');
    return { resolved, remaining: products };
  }

  const wooAuth = `consumer_key=${config.woocommerce_consumer_key}&consumer_secret=${config.woocommerce_consumer_secret}`;
  const headers = {
    'User-Agent': 'PIM-Sync/1.0 (SKU Preflight)',
    'Accept': 'application/json',
  };

  // Strategy 1: batch check via local woo_products cache (fast, no API calls)
  const skus = products.map(p => p.sku);
  const skuBatches: string[][] = [];
  for (let i = 0; i < skus.length; i += 200) {
    skuBatches.push(skus.slice(i, i + 200));
  }

  const cachedBysku = new Map<string, { woo_id: number; id: string }>();
  for (const batch of skuBatches) {
    const { data: cached } = await supabase
      .from('woo_products')
      .select('sku, woo_id, id')
      .eq('tenant_id', tenantId)
      .in('sku', batch);
    if (cached) {
      for (const c of cached) {
        if (c.sku) cachedBysku.set(c.sku, c);
      }
    }
  }

  // Link products found in local cache
  const uncachedProducts: typeof products = [];
  for (const p of products) {
    const cached = cachedBysku.get(p.sku);
    if (cached) {
      await supabase.from('products')
        .update({ woocommerce_product_id: cached.woo_id })
        .eq('id', p.id);
      // Ensure product_id link exists in cache
      await supabase.from('woo_products')
        .update({ product_id: p.id })
        .eq('id', cached.id);
      resolved.push(p.sku);
      console.log(`[preflight] ${p.sku}: linked to WC #${cached.woo_id} via local cache`);
    } else {
      uncachedProducts.push(p);
    }
  }

  // Strategy 2: API lookup for remaining products (max 20 to stay within limits)
  const apiCheckLimit = Math.min(uncachedProducts.length, 20);
  const toApiCheck = uncachedProducts.slice(0, apiCheckLimit);
  const apiResolved: string[] = [];

  for (const p of toApiCheck) {
    try {
      const resp = await fetch(
        `${config.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(p.sku)}&per_page=1&${wooAuth}`,
        { headers },
      );
      if (!resp.ok) {
        // Try search fallback
        const searchResp = await fetch(
          `${config.woocommerce_url}/wp-json/wc/v3/products?search=${encodeURIComponent(p.sku)}&per_page=5&${wooAuth}`,
          { headers },
        );
        if (searchResp.ok) {
          const searchResults = await searchResp.json();
          const match = searchResults.find((r: any) => r.sku === p.sku);
          if (match) {
            await linkProduct(supabase, p, match, tenantId);
            resolved.push(p.sku);
            apiResolved.push(p.sku);
            continue;
          }
        }
        continue;
      }
      const results = await resp.json();
      if (Array.isArray(results) && results.length > 0) {
        await linkProduct(supabase, p, results[0], tenantId);
        resolved.push(p.sku);
        apiResolved.push(p.sku);
      }
    } catch (e) {
      console.warn(`[preflight] API check failed for ${p.sku}: ${e}`);
    }
  }

  if (apiResolved.length > 0) {
    console.log(`[preflight] Resolved ${apiResolved.length} SKUs via WooCommerce API`);
  }

  const remaining = uncachedProducts.filter(p => !apiResolved.includes(p.sku));
  return { resolved, remaining };
}

async function linkProduct(
  supabase: any,
  pim: { id: string; sku: string; title: string; tenant_id: string },
  woo: { id: number; slug?: string; status?: string; type?: string },
  tenantId: string,
) {
  await supabase.from('products')
    .update({ woocommerce_product_id: woo.id })
    .eq('id', pim.id);

  await supabase.from('woo_products').upsert({
    tenant_id: tenantId,
    woo_id: woo.id,
    product_id: pim.id,
    sku: pim.sku,
    name: pim.title,
    slug: woo.slug || '',
    status: woo.status || 'publish',
    type: woo.type || 'variable',
    last_pushed_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,woo_id' });

  await supabase.from('changelog').insert({
    tenant_id: tenantId,
    event_type: 'SKU_CONFLICT_PREVENTED',
    description: `Preflight: SKU ${pim.sku} al aanwezig in WooCommerce als #${woo.id} — automatisch gekoppeld`,
    metadata: { sku: pim.sku, woo_id: woo.id, product_id: pim.id },
  });

  console.log(`[preflight] ${pim.sku}: linked to WC #${woo.id}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Starting sync-new-products...');

    // Query products that don't have a WooCommerce ID yet
    const { data: newProducts, error: dbError } = await supabase
      .from('products')
      .select('id, sku, title, tenant_id')
      .is('woocommerce_product_id', null)
      .not('sku', 'is', null)
      .not('title', 'is', null);

    if (dbError) throw dbError;

    if (!newProducts || newProducts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No new products to create', new_products_found: 0, preflight_resolved: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${newProducts.length} products without woocommerce_product_id`);

    // ── Proactive SKU conflict resolution ──
    const tenantId = newProducts[0].tenant_id;
    const { resolved, remaining: afterPreflight } = await resolveExistingSkus(supabase, newProducts, tenantId);
    if (resolved.length > 0) {
      console.log(`Preflight resolved ${resolved.length} SKU conflicts (linked existing WC products)`);
    }

    // Check which products already have pending jobs
    let missingProducts = afterPreflight;
    if (afterPreflight.length > 0) {
      const { data: existingJobs } = await supabase
        .from('jobs')
        .select('payload')
        .in('state', ['ready', 'processing'])
        .in('type', ['CREATE_NEW_PRODUCTS', 'SYNC_TO_WOO']);

      const alreadyQueued = new Set<string>();
      if (existingJobs) {
        for (const job of existingJobs) {
          const ids = (job.payload as any)?.productIds;
          if (Array.isArray(ids)) {
            for (const id of ids) alreadyQueued.add(id);
          }
        }
      }

      missingProducts = afterPreflight.filter(p => !alreadyQueued.has(p.id));
      if (missingProducts.length < afterPreflight.length) {
        console.log(`Filtered out ${afterPreflight.length - missingProducts.length} products already queued`);
      }
    }

    console.log(`${missingProducts.length} new products to create`);

    if (missingProducts.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: resolved.length > 0
            ? `${resolved.length} SKU conflicts resolved, no new products to create`
            : 'All new products already queued',
          new_products_found: 0,
          preflight_resolved: resolved.length,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create jobs in batches of 3
    const BATCH_SIZE = 3;
    let jobsCreated = 0;

    for (let i = 0; i < missingProducts.length; i += BATCH_SIZE) {
      const batch = missingProducts.slice(i, i + BATCH_SIZE);
      const productIds = batch.map(p => p.id);

      const { error: jobErr } = await supabase.from('jobs').insert({
        type: 'SYNC_TO_WOO',
        state: 'ready',
        payload: { productIds, syncScope: 'FULL', isNewProduct: true },
        tenant_id: tenantId,
        scope: 'FULL',
        priority: 30,
      });
      if (jobErr && jobErr.code === '23505') {
        console.log(`Skipping duplicate job for batch ${i} (already queued)`);
        continue;
      }

      jobsCreated++;
    }

    console.log(`Created ${jobsCreated} jobs for ${missingProducts.length} new products`);

    return new Response(
      JSON.stringify({
        success: true,
        new_products_found: missingProducts.length,
        jobs_created: jobsCreated,
        preflight_resolved: resolved.length,
        preflight_skus: resolved.slice(0, 20),
        missing_skus: missingProducts.slice(0, 50).map(p => p.sku),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in sync-new-products:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
