import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooProductData {
  slug: string;
  images: string[];
}

/**
 * Mass validator: fetches ALL WooCommerce products, builds an in-memory
 * SKU→{slug, images} map, then bulk-updates url_key and images in the
 * local database. Uses paginated WC API fetching to avoid per-SKU lookups.
 *
 * Params: { tenantId, dryRun?, localOffset?, localLimit? }
 *
 * Step 1 (automatic): fetch all WC products into memory map
 * Step 2: iterate local products in batches and apply updates
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const {
      tenantId,
      dryRun = false,
      localOffset = 0,
      localLimit = 500,
    } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    // Get WooCommerce credentials
    const { data: config, error: cfgErr } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();
    if (cfgErr || !config) throw new Error(`No tenant config: ${cfgErr?.message}`);

    const wooUrl = config.woocommerce_url.replace(/\/$/, '');
    const ck = config.woocommerce_consumer_key;
    const cs = config.woocommerce_consumer_secret;

    // ── Step 1: Fetch ALL WooCommerce products into a SKU map ──
    const wooMap = new Map<string, WooProductData>();
    let page = 1;
    const perPage = 100;

    console.log('Fetching all WooCommerce products…');

    while (true) {
      const url = `${wooUrl}/wp-json/wc/v3/products?consumer_key=${ck}&consumer_secret=${cs}&per_page=${perPage}&page=${page}&_fields=id,sku,slug,images`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`WC API error on page ${page}: ${res.status}`);
        break;
      }

      const products = await res.json();
      if (!products || products.length === 0) break;

      for (const p of products) {
        if (!p.sku) continue;
        const imgs: string[] = (p.images || [])
          .map((i: any) => i.src)
          .filter((src: string) => src && !src.includes('placeholder'));

        wooMap.set(p.sku, { slug: p.slug, images: imgs });

        // Also map with trailing 000 for Modis convention
        if (!p.sku.endsWith('000')) {
          wooMap.set(p.sku + '000', { slug: p.slug, images: imgs });
        }
      }

      if (products.length < perPage) break;
      page++;

      // Small pause to avoid rate limits
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`WC map built: ${wooMap.size} SKU entries from ${page} pages`);

    // ── Step 2: Fetch local products and compare ──
    const { data: localProducts, error: prodErr, count } = await supabase
      .from('products')
      .select('id, sku, url_key, images', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('sku')
      .range(localOffset, localOffset + localLimit - 1);

    if (prodErr) throw new Error(`Failed to fetch products: ${prodErr.message}`);

    let slugUpdated = 0;
    let imgUpdated = 0;
    let bothUpdated = 0;
    let alreadyCorrect = 0;
    let notInWoo = 0;
    let errors = 0;
    const samples: any[] = [];

    // Batch updates for efficiency
    const updates: { id: string; url_key?: string; images?: string[] }[] = [];

    for (const product of localProducts || []) {
      const woo = wooMap.get(product.sku);
      if (!woo) {
        notInWoo++;
        continue;
      }

      let needSlugUpdate = false;
      let needImgUpdate = false;

      // Check slug
      if (woo.slug && product.url_key !== woo.slug) {
        needSlugUpdate = true;
      }

      // Check images — replace if any are storage URLs or if WC images differ
      const currentImages = (product.images as string[]) || [];
      const hasStorageUrl = currentImages.some(
        (u: string) => typeof u === 'string' && u.includes('supabase.co/storage')
      );
      const imagesMatch =
        !hasStorageUrl &&
        currentImages.length === woo.images.length &&
        currentImages.every((img, idx) => img === woo.images[idx]);

      if (woo.images.length > 0 && !imagesMatch) {
        needImgUpdate = true;
      }

      if (!needSlugUpdate && !needImgUpdate) {
        alreadyCorrect++;
        continue;
      }

      const update: any = { id: product.id };
      if (needSlugUpdate) update.url_key = woo.slug;
      if (needImgUpdate) update.images = woo.images;
      updates.push(update);

      if (needSlugUpdate && needImgUpdate) bothUpdated++;
      else if (needSlugUpdate) slugUpdated++;
      else imgUpdated++;

      if (samples.length < 20) {
        samples.push({
          sku: product.sku,
          slugChange: needSlugUpdate ? { old: product.url_key, new: woo.slug } : null,
          imgChange: needImgUpdate
            ? { oldCount: currentImages.length, newCount: woo.images.length, hadStorage: hasStorageUrl }
            : null,
        });
      }
    }

    // Apply updates in batches of 50
    if (!dryRun && updates.length > 0) {
      const BATCH = 50;
      for (let i = 0; i < updates.length; i += BATCH) {
        const batch = updates.slice(i, i + BATCH);
        const promises = batch.map((u) => {
          const { id, ...fields } = u;
          return supabase.from('products').update(fields).eq('id', id);
        });
        const results = await Promise.all(promises);
        for (const r of results) {
          if (r.error) errors++;
        }
      }
    }

    const nextOffset = localOffset + (localProducts?.length || 0);
    const hasMore = nextOffset < (count || 0);

    const summary = {
      wooProductsInMap: wooMap.size,
      localProcessed: localProducts?.length || 0,
      localTotal: count,
      slugUpdated,
      imgUpdated,
      bothUpdated,
      totalUpdated: slugUpdated + imgUpdated + bothUpdated,
      alreadyCorrect,
      notInWoo,
      errors,
      dryRun,
      offset: localOffset,
      nextOffset: hasMore ? nextOffset : null,
    };

    // Log to changelog when done (last batch or only batch)
    if (!dryRun && summary.totalUpdated > 0 && !hasMore) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_URL_VALIDATION',
        description: `Mass URL validatie: ${summary.totalUpdated} producten bijgewerkt (${slugUpdated} slug, ${imgUpdated} img, ${bothUpdated} beide)`,
        metadata: summary,
      });
    }

    console.log('Summary:', JSON.stringify(summary));

    return new Response(
      JSON.stringify({ summary, samples }, null, 2),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
