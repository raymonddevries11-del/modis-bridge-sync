import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PIM-Sync/1.0)',
  'Accept': 'application/json',
};

interface WooProduct {
  id: number;
  sku: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  stock_quantity: number;
  permalink: string;
  regular_price: string;
  sale_price: string;
  stock_status: string;
  categories: any[];
  tags: any[];
  images: any[];
}

interface CacheProgress {
  phase: 'products' | 'variations' | 'upsert' | 'done';
  productPage: number;
  variableIndex: number;
  totalProducts: number;
  totalVariations: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    const body = await req.json().catch(() => ({}));
    const { tenantId, phase } = body;

    if (!tenantId) throw new Error('tenantId is required');

    // Get tenant config
    const { data: tenantConfig } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!tenantConfig) throw new Error('No tenant config found');

    const progressKey = `woo_cache_progress_${tenantId}`;

    // Load existing progress
    const { data: progressData } = await supabase
      .from('config')
      .select('value')
      .eq('key', progressKey)
      .maybeSingle();

    const progress: CacheProgress = (progressData?.value as any) ?? {
      phase: 'products',
      productPage: 1,
      variableIndex: 0,
      totalProducts: 0,
      totalVariations: 0,
    };

    // Override phase if explicitly requested
    if (phase === 'products') {
      progress.phase = 'products';
      progress.productPage = 1;
    } else if (phase === 'variations') {
      progress.phase = 'variations';
    } else if (phase === 'upsert') {
      progress.phase = 'upsert';
    }

    console.log(`Phase: ${progress.phase}, page: ${progress.productPage}, varIdx: ${progress.variableIndex}`);

    // ──────────────────────────────────
    // PHASE 1: Fetch products page by page → upsert directly into woo_products
    // ──────────────────────────────────
    if (progress.phase === 'products') {
      const MAX_PAGES_PER_RUN = 15; // ~15 pages × 100 = 1500 products per run
      let page = progress.productPage;
      let pagesProcessed = 0;
      let productsThisRun = 0;

      while (pagesProcessed < MAX_PAGES_PER_RUN) {
        const url = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products`);
        url.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
        url.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);
        url.searchParams.append('per_page', '100');
        url.searchParams.append('page', String(page));
        url.searchParams.append('status', 'any');

        const response = await fetch(url.toString(), { headers: FETCH_HEADERS });

        if (!response.ok) {
          const text = await response.text();
          if (text.includes('<html') || text.includes('sgcapt')) {
            console.warn(`SiteGround blocked page ${page}, saving progress and stopping`);
            break;
          }
          throw new Error(`WooCommerce API error page ${page}: ${response.status}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          console.warn(`Non-JSON response on page ${page}, stopping`);
          break;
        }

        const products: WooProduct[] = await response.json();
        console.log(`Products page ${page}: ${products.length} items`);

        if (products.length > 0) {
          // Upsert directly into woo_products
          const rows = products
            .filter(p => p.sku)
            .map(p => ({
              woo_id: p.id,
              tenant_id: tenantId,
              sku: p.sku,
              name: p.name,
              slug: p.slug || null,
              type: p.type || 'simple',
              status: p.status || 'publish',
              stock_quantity: p.stock_quantity || 0,
              stock_status: p.stock_status || 'instock',
              permalink: p.permalink || null,
              regular_price: p.regular_price || null,
              sale_price: p.sale_price || null,
              categories: p.categories || [],
              tags: p.tags || [],
              images: p.images || [],
              last_fetched_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }));

          if (rows.length > 0) {
            const { error: upsertErr } = await supabase
              .from('woo_products')
              .upsert(rows, { onConflict: 'tenant_id,woo_id', ignoreDuplicates: false });

            if (upsertErr) {
              console.error(`Upsert error page ${page}:`, upsertErr.message);
            }
          }

          productsThisRun += products.length;
          progress.totalProducts += products.length;
        }

        if (products.length < 100) {
          // All products fetched
          progress.phase = 'upsert'; // skip variations for now, go to linking
          progress.productPage = page;
          break;
        }

        page++;
        pagesProcessed++;

        // Polite delay
        await new Promise(r => setTimeout(r, 500));
      }

      // If we hit the page limit but not done, save progress for next run
      if (progress.phase === 'products') {
        progress.productPage = page;
      }

      // Save progress
      await supabase.from('config').upsert({
        key: progressKey,
        value: progress as any,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      console.log(`Products phase: ${productsThisRun} this run, ${progress.totalProducts} total. Next phase: ${progress.phase}`);

      const needsContinuation = progress.phase === 'products';

      // Self-invoke for continuation if needed
      if (needsContinuation) {
        const selfUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/cache-woo-products`;
        fetch(selfUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
          },
          body: JSON.stringify({ tenantId }),
        }).catch(() => { /* fire and forget */ });
      }

      return new Response(
        JSON.stringify({
          success: true,
          phase: progress.phase,
          productsThisRun,
          totalProducts: progress.totalProducts,
          hasMore: needsContinuation,
          message: needsContinuation
            ? `Nog meer pagina\'s op te halen, auto-vervolg gestart`
            : `Alle producten opgehaald, volgende fase: ${progress.phase}`,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ──────────────────────────────────
    // PHASE 2: Link woo_products to PIM products via SKU
    // ──────────────────────────────────
    if (progress.phase === 'upsert') {
      console.log('Linking WooCommerce products to PIM products by SKU...');

      // Get all PIM products
      const { data: pimProducts } = await supabase
        .from('products')
        .select('id, sku')
        .eq('tenant_id', tenantId);

      const pimBySku = new Map<string, string>();
      for (const p of pimProducts ?? []) {
        if (p.sku) pimBySku.set(p.sku, p.id);
      }

      // Get unlinked woo_products
      const { data: unlinked } = await supabase
        .from('woo_products')
        .select('id, sku')
        .eq('tenant_id', tenantId)
        .is('product_id', null);

      let linked = 0;
      const updates: { id: string; product_id: string }[] = [];

      for (const wp of unlinked ?? []) {
        const pimId = pimBySku.get(wp.sku);
        if (pimId) {
          updates.push({ id: wp.id, product_id: pimId });
        }
      }

      // Batch update
      for (let i = 0; i < updates.length; i += 100) {
        const batch = updates.slice(i, i + 100);
        for (const u of batch) {
          await supabase
            .from('woo_products')
            .update({ product_id: u.product_id })
            .eq('id', u.id);
        }
        linked += batch.length;
      }

      progress.phase = 'done';

      await supabase.from('config').upsert({
        key: progressKey,
        value: progress as any,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      // Count totals
      const { count: totalWoo } = await supabase
        .from('woo_products')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);

      const { count: linkedCount } = await supabase
        .from('woo_products')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .not('product_id', 'is', null);

      // Log to changelog
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_CACHE_BUILT',
        description: `WooCommerce cache opgebouwd: ${totalWoo} producten, ${linkedCount} gekoppeld aan PIM`,
        metadata: { total_woo: totalWoo, linked: linkedCount, newly_linked: linked },
      });

      console.log(`Linking complete: ${linked} newly linked, ${linkedCount}/${totalWoo} total linked`);

      return new Response(
        JSON.stringify({
          success: true,
          phase: 'done',
          totalWooProducts: totalWoo,
          linkedToPim: linkedCount,
          newlyLinked: linked,
          unlinked: (totalWoo ?? 0) - (linkedCount ?? 0),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Phase done — just report status
    const { count: totalWoo } = await supabase
      .from('woo_products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const { count: linkedCount } = await supabase
      .from('woo_products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .not('product_id', 'is', null);

    return new Response(
      JSON.stringify({
        success: true,
        phase: 'done',
        totalWooProducts: totalWoo,
        linkedToPim: linkedCount,
        message: 'Cache is al compleet',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in cache-woo-products:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
