import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    const { tenantId, dryRun = false, jobId } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    // Get WooCommerce credentials
    const { data: config } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();
    if (!config) throw new Error('No tenant config found');

    const wooUrl = config.woocommerce_url.replace(/\/$/, '');
    const ck = config.woocommerce_consumer_key;
    const cs = config.woocommerce_consumer_secret;

    // Find products with bad url_key
    const { data: badProducts, error } = await supabase
      .from('products')
      .select('id, sku, url_key, title')
      .eq('tenant_id', tenantId)
      .or('url_key.eq.-nvt,url_key.is.null,url_key.eq.');

    if (error) throw error;
    console.log(`Found ${badProducts?.length || 0} products with bad url_key`);

    if (!badProducts || badProducts.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No products with bad url_key found', fixed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Look up each product in WooCommerce by SKU
    const results: { sku: string; title: string; oldKey: string | null; newSlug: string | null; status: string }[] = [];

    for (const product of badProducts) {
      const url = `${wooUrl}/wp-json/wc/v3/products?consumer_key=${ck}&consumer_secret=${cs}&sku=${encodeURIComponent(product.sku)}&_fields=id,slug,permalink`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          results.push({ sku: product.sku, title: product.title, oldKey: product.url_key, newSlug: null, status: `WC API error: ${res.status}` });
          continue;
        }
        const wooProducts = await res.json();
        if (!wooProducts || wooProducts.length === 0) {
          results.push({ sku: product.sku, title: product.title, oldKey: product.url_key, newSlug: null, status: 'not found in WooCommerce' });
          continue;
        }

        const slug = wooProducts[0].slug;
        if (!slug) {
          results.push({ sku: product.sku, title: product.title, oldKey: product.url_key, newSlug: null, status: 'WC product has no slug' });
          continue;
        }

        if (!dryRun) {
          const { error: updateErr } = await supabase
            .from('products')
            .update({ url_key: slug })
            .eq('id', product.id);
          if (updateErr) {
            results.push({ sku: product.sku, title: product.title, oldKey: product.url_key, newSlug: slug, status: `update error: ${updateErr.message}` });
            continue;
          }
        }

        results.push({ sku: product.sku, title: product.title, oldKey: product.url_key, newSlug: slug, status: dryRun ? 'would fix' : 'fixed' });

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        results.push({ sku: product.sku, title: product.title, oldKey: product.url_key, newSlug: null, status: `error: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    const fixed = results.filter(r => r.status === 'fixed' || r.status === 'would fix').length;

    if (!dryRun && fixed > 0) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'FIX_URL_KEYS',
        description: `Fixed ${fixed} products with bad url_key (-nvt or empty)`,
        metadata: { results },
      });
    }

    return new Response(
      JSON.stringify({ dryRun, total: badProducts.length, fixed, results }, null, 2),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('Error:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
