import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Bulk image URL refresh: fetches ALL WooCommerce products into an in-memory
 * SKU→images map, then updates local product image arrays in batch.
 * Uses the efficient paginated bulk-fetch pattern to avoid per-SKU lookups.
 *
 * Params: { tenantId, dryRun?, offset?, limit? }
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
      offset = 0,
      limit = 500,
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

    // ── Step 1: Build in-memory SKU→images map from WooCommerce ──
    const wooMap = new Map<string, string[]>();
    let page = 1;
    const perPage = 100;

    console.log('Fetching all WooCommerce products for image map…');

    while (true) {
      const url = `${wooUrl}/wp-json/wc/v3/products?consumer_key=${ck}&consumer_secret=${cs}&per_page=${perPage}&page=${page}&_fields=id,sku,images`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`WC API error page ${page}: ${res.status}`);
        break;
      }

      const products = await res.json();
      if (!products || products.length === 0) break;

      for (const p of products) {
        if (!p.sku) continue;
        const imgs: string[] = (p.images || [])
          .map((i: any) => i.src)
          .filter((src: string) => src && !src.includes('placeholder'));

        if (imgs.length > 0) {
          wooMap.set(p.sku, imgs);
          // Also map with trailing 000 for Modis convention
          if (!p.sku.endsWith('000')) {
            wooMap.set(p.sku + '000', imgs);
          }
        }
      }

      if (products.length < perPage) break;
      page++;
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`WC image map: ${wooMap.size} SKU entries from ${page} pages`);

    // ── Step 2: Fetch local products and compare images ──
    const { data: localProducts, error: prodErr, count } = await supabase
      .from('products')
      .select('id, sku, images', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('sku')
      .range(offset, offset + limit - 1);

    if (prodErr) throw new Error(`Failed to fetch products: ${prodErr.message}`);

    let updated = 0;
    let alreadyCorrect = 0;
    let notInWoo = 0;
    let errors = 0;
    const samples: any[] = [];

    const updates: { id: string; images: string[] }[] = [];

    for (const product of localProducts || []) {
      const wooImages = wooMap.get(product.sku);
      if (!wooImages) {
        notInWoo++;
        continue;
      }

      const currentImages = (product.images as string[]) || [];
      const hasStorageUrl = currentImages.some(
        (u: string) => typeof u === 'string' && u.includes('supabase.co/storage')
      );
      const imagesMatch =
        !hasStorageUrl &&
        currentImages.length === wooImages.length &&
        currentImages.every((img, idx) => img === wooImages[idx]);

      if (imagesMatch) {
        alreadyCorrect++;
        continue;
      }

      updates.push({ id: product.id, images: wooImages });
      updated++;

      if (samples.length < 30) {
        samples.push({
          sku: product.sku,
          oldCount: currentImages.length,
          newCount: wooImages.length,
          hadStorage: hasStorageUrl,
          oldFirst: currentImages[0]?.split('/').pop() || '—',
          newFirst: wooImages[0]?.split('/').pop() || '—',
        });
      }
    }

    // Apply updates in batches of 50
    if (!dryRun && updates.length > 0) {
      const BATCH = 50;
      for (let i = 0; i < updates.length; i += BATCH) {
        const batch = updates.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map((u) =>
            supabase.from('products').update({ images: u.images }).eq('id', u.id)
          )
        );
        for (const r of results) {
          if (r.error) errors++;
        }
      }
    }

    const nextOffset = offset + (localProducts?.length || 0);
    const hasMore = nextOffset < (count || 0);

    const summary = {
      wooProductsInMap: wooMap.size,
      localProcessed: localProducts?.length || 0,
      localTotal: count,
      updated,
      alreadyCorrect,
      notInWoo,
      errors,
      dryRun,
      offset,
      nextOffset: hasMore ? nextOffset : null,
    };

    // Log to changelog on last batch
    if (!dryRun && updated > 0 && !hasMore) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'BULK_IMAGE_REFRESH',
        description: `Bulk image refresh: ${updated} producten bijgewerkt vanuit WooCommerce`,
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
