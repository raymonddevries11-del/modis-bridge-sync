import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Try to find a WooCommerce product by SKU.
 * Falls back to base SKU (without trailing "000") if exact match fails.
 */
async function findWooProduct(wooUrl: string, ck: string, cs: string, sku: string): Promise<any | null> {
  // Try exact SKU first
  const url1 = `${wooUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&consumer_key=${ck}&consumer_secret=${cs}`;
  const res1 = await fetch(url1);
  if (res1.ok) {
    const products = await res1.json();
    if (products?.length > 0) return products[0];
  }

  // Try base SKU without trailing "000" (common Modis pattern)
  if (sku.endsWith('000') && sku.length > 6) {
    const baseSku = sku.slice(0, -3);
    const url2 = `${wooUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(baseSku)}&consumer_key=${ck}&consumer_secret=${cs}`;
    const res2 = await fetch(url2);
    if (res2.ok) {
      const products = await res2.json();
      if (products?.length > 0) return products[0];
    }
  }

  // Try search by slug-like partial match
  const url3 = `${wooUrl}/wp-json/wc/v3/products?search=${encodeURIComponent(sku.replace(/000$/, ''))}&consumer_key=${ck}&consumer_secret=${cs}&per_page=5`;
  const res3 = await fetch(url3);
  if (res3.ok) {
    const products = await res3.json();
    // Find exact or close SKU match
    const match = products?.find((p: any) => 
      p.sku === sku || p.sku === sku.replace(/000$/, '') ||
      sku.startsWith(p.sku)
    );
    if (match) return match;
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { tenantId, dryRun = true, offset = 0, limit = 50, onlySupabaseUrls = false } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    // Get WooCommerce config
    const { data: config, error: cfgErr } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();
    if (cfgErr || !config) throw new Error(`No tenant config: ${cfgErr?.message}`);

    const wooUrl = config.woocommerce_url.replace(/\/$/, '');
    const ck = config.woocommerce_consumer_key;
    const cs = config.woocommerce_consumer_secret;

    // Build query - optionally filter to only products with Supabase storage URLs
    let query = supabase
      .from('products')
      .select('id, sku, title, images', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('sku');

    // Note: can't filter jsonb with LIKE via SDK, so we filter in-memory after fetch
    const { data: allProducts, error: prodErr, count } = await query.range(offset, offset + limit - 1);

    // Filter to only products with Supabase storage URLs if requested
    const products = onlySupabaseUrls
      ? (allProducts || []).filter(p => JSON.stringify(p.images || []).includes('supabase'))
      : (allProducts || []);
    if (prodErr) throw new Error(`Failed to fetch products: ${prodErr.message}`);

    console.log(`Processing ${products.length} products (offset=${offset}, total=${count}, onlySupabase=${onlySupabaseUrls})`);

    const results: any[] = [];
    let updated = 0;
    let matched = 0;
    let notFound = 0;
    let errors = 0;
    let noImages = 0;

    const BATCH = 5;
    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);

      const promises = batch.map(async (product) => {
        try {
          const wooProduct = await findWooProduct(wooUrl, ck, cs, product.sku);

          if (!wooProduct) {
            notFound++;
            results.push({ sku: product.sku, status: 'not_found_in_woo' });
            return;
          }

          const wooImages: string[] = (wooProduct.images || [])
            .map((img: any) => img.src)
            .filter((src: string) => src && !src.includes('placeholder'));

          if (wooImages.length === 0) {
            noImages++;
            results.push({ sku: product.sku, status: 'no_woo_images' });
            return;
          }

          // Check if current images already match WooCommerce
          const currentImages = (product.images as string[]) || [];
          const alreadyMatch = currentImages.length === wooImages.length &&
            currentImages.every((img, idx) => img === wooImages[idx]);

          if (alreadyMatch) {
            matched++;
            results.push({ sku: product.sku, status: 'already_correct', imageCount: wooImages.length });
            return;
          }

          if (!dryRun) {
            const { error: updateErr } = await supabase
              .from('products')
              .update({ images: wooImages })
              .eq('id', product.id);

            if (updateErr) {
              errors++;
              results.push({ sku: product.sku, status: 'update_error', error: updateErr.message });
              return;
            }
          }

          updated++;
          results.push({
            sku: product.sku,
            status: dryRun ? 'would_update' : 'updated',
            oldCount: currentImages.length,
            newCount: wooImages.length,
            oldSample: currentImages[0],
            newSample: wooImages[0],
          });
        } catch (e) {
          errors++;
          results.push({ sku: product.sku, status: 'error', error: e.message });
        }
      });

      await Promise.all(promises);
      if (i + BATCH < products.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const summary = {
      total: count,
      processed: products.length,
      offset,
      nextOffset: offset + products.length < (count || 0) ? offset + products.length : null,
      matched,
      updated,
      notFound,
      noImages,
      errors,
      dryRun,
      onlySupabaseUrls,
    };

    console.log('Summary:', JSON.stringify(summary));

    return new Response(
      JSON.stringify({ summary, results }, null, 2),
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
