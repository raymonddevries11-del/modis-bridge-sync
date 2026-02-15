import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Syncs WooCommerce-hosted image URLs back into the products table.
 * Replaces any Supabase storage URLs with the live WooCommerce image URLs
 * so the Google Merchant feed always references externally-hosted images.
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

    const { tenantId, dryRun = false, offset = 0, limit = 100 } = await req.json();
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

    // Fetch products that have storage URLs in their images
    const { data: allProducts, error: prodErr, count } = await supabase
      .from('products')
      .select('id, sku, title, images', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .not('images', 'is', null)
      .order('sku')
      .range(offset, offset + limit - 1);

    if (prodErr) throw new Error(`Failed to fetch products: ${prodErr.message}`);

    // Filter to products that have at least one storage URL
    const products = (allProducts || []).filter((p) => {
      const imgs = p.images as string[];
      return Array.isArray(imgs) && imgs.some((url: string) =>
        typeof url === 'string' && url.includes('supabase.co/storage')
      );
    });

    console.log(`Batch ${offset}: ${allProducts?.length} fetched, ${products.length} have storage URLs (total=${count})`);

    let updated = 0;
    let skipped = 0;
    let notFound = 0;
    let errors = 0;
    const results: any[] = [];

    // Process in small concurrent batches
    const BATCH = 5;
    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);

      await Promise.all(batch.map(async (product) => {
        try {
          const sku = product.sku;
          const wooProduct = await findWooProduct(wooUrl, ck, cs, sku);

          if (!wooProduct) {
            notFound++;
            results.push({ sku, status: 'not_found_in_woo' });
            return;
          }

          const wooImages: string[] = (wooProduct.images || [])
            .map((img: any) => img.src)
            .filter((src: string) => src && !src.includes('placeholder'));

          if (wooImages.length === 0) {
            skipped++;
            results.push({ sku, status: 'no_woo_images' });
            return;
          }

          if (!dryRun) {
            const { error: updateErr } = await supabase
              .from('products')
              .update({ images: wooImages })
              .eq('id', product.id);

            if (updateErr) {
              errors++;
              results.push({ sku, status: 'update_error', error: updateErr.message });
              return;
            }
          }

          updated++;
          results.push({
            sku,
            status: dryRun ? 'would_update' : 'updated',
            imageCount: wooImages.length,
            sample: wooImages[0],
          });
        } catch (e) {
          errors++;
          results.push({ sku: product.sku, status: 'error', error: e.message });
        }
      }));

      // Rate limit courtesy pause
      if (i + BATCH < products.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const nextOffset = offset + (allProducts?.length || 0);
    const hasMore = nextOffset < (count || 0);

    const summary = {
      total: count,
      processed: allProducts?.length || 0,
      withStorageUrls: products.length,
      updated,
      skipped,
      notFound,
      errors,
      dryRun,
      offset,
      nextOffset: hasMore ? nextOffset : null,
    };

    // Log to changelog if we actually updated something
    if (updated > 0 && !dryRun) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('slug')
        .eq('id', tenantId)
        .single();

      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_IMAGE_URL_SYNC',
        description: `${updated} producten bijgewerkt met WooCommerce afbeeldings-URLs`,
        metadata: { ...summary, results: results.slice(0, 50) },
      });
    }

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

/** Try to find a WooCommerce product by SKU with fallback strategies */
async function findWooProduct(wooUrl: string, ck: string, cs: string, sku: string): Promise<any | null> {
  // Try exact SKU
  const url1 = `${wooUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&consumer_key=${ck}&consumer_secret=${cs}&per_page=1`;
  const res1 = await fetch(url1);
  if (res1.ok) {
    const products = await res1.json();
    if (products?.length > 0) return products[0];
  }

  // Try base SKU without trailing "000"
  if (sku.endsWith('000') && sku.length > 6) {
    const baseSku = sku.slice(0, -3);
    const url2 = `${wooUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(baseSku)}&consumer_key=${ck}&consumer_secret=${cs}&per_page=1`;
    const res2 = await fetch(url2);
    if (res2.ok) {
      const products = await res2.json();
      if (products?.length > 0) return products[0];
    }
  }

  return null;
}
