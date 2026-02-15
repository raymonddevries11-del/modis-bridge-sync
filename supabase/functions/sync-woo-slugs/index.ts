import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { tenantId, dryRun = true, offset = 0, limit = 50 } = await req.json();
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

    // Get products page
    const { data: products, error: prodErr, count } = await supabase
      .from('products')
      .select('id, sku, title, url_key', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('sku')
      .range(offset, offset + limit - 1);
    if (prodErr) throw new Error(`Failed to fetch products: ${prodErr.message}`);

    console.log(`Processing ${products.length} products (offset=${offset}, total=${count})`);

    const results: any[] = [];
    let updated = 0;
    let matched = 0;
    let notFound = 0;
    let errors = 0;

    // Process sequentially in small groups to avoid WooCommerce rate limits
    const BATCH = 5;
    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);

      const promises = batch.map(async (product) => {
        try {
          const url = `${wooUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(product.sku)}&consumer_key=${ck}&consumer_secret=${cs}`;
          const res = await fetch(url);
          if (!res.ok) {
            errors++;
            results.push({ sku: product.sku, status: 'api_error', code: res.status });
            return;
          }

          const wooProducts = await res.json();
          if (!wooProducts || wooProducts.length === 0) {
            notFound++;
            results.push({ sku: product.sku, status: 'not_found_in_woo' });
            return;
          }

          const wooSlug = wooProducts[0].slug;
          const wooPermalink = wooProducts[0].permalink;

          if (product.url_key === wooSlug) {
            matched++;
            results.push({ sku: product.sku, status: 'already_correct', slug: wooSlug });
            return;
          }

          if (!dryRun) {
            const { error: updateErr } = await supabase
              .from('products')
              .update({ url_key: wooSlug })
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
            old: product.url_key,
            new: wooSlug,
            permalink: wooPermalink,
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
      errors,
      dryRun,
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
