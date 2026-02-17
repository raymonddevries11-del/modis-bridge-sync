import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
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
    const { tenantId } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    // 1. Get tenant WC config
    const { data: config } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();
    if (!config) throw new Error('No tenant config found');

    const wooUrl = config.woocommerce_url.replace(/\/$/, '');
    const ck = config.woocommerce_consumer_key;
    const cs = config.woocommerce_consumer_secret;

    // 2. Refresh global attributes cache from WC API
    console.log('🔄 Refreshing global attributes cache...');
    const attrsUrl = `${wooUrl}/wp-json/wc/v3/products/attributes?consumer_key=${ck}&consumer_secret=${cs}&per_page=100`;
    const attrsRes = await fetch(attrsUrl);
    if (!attrsRes.ok) throw new Error(`WC attributes API error: ${attrsRes.status}`);
    const wcAttributes: { id: number; name: string; slug: string }[] = await attrsRes.json();

    // Upsert each into woo_global_attributes with fresh terms
    let refreshedCount = 0;
    for (const attr of wcAttributes) {
      const termsUrl = `${wooUrl}/wp-json/wc/v3/products/attributes/${attr.id}/terms?consumer_key=${ck}&consumer_secret=${cs}&per_page=100`;
      let terms: any[] = [];
      try {
        const termsRes = await fetch(termsUrl);
        if (termsRes.ok) terms = await termsRes.json();
      } catch { /* skip */ }

      await supabase.from('woo_global_attributes').upsert({
        tenant_id: tenantId,
        woo_attr_id: attr.id,
        name: attr.name,
        slug: attr.slug,
        terms: terms.map((t: any) => ({ id: t.id, name: t.name, slug: t.slug, count: t.count })),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,woo_attr_id' });
      refreshedCount++;
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`✓ Refreshed ${refreshedCount} global attributes`);

    // 3. Get all linked WC products for this tenant
    const { data: wooProducts, error: wpErr } = await supabase
      .from('woo_products')
      .select('woo_id, sku, name')
      .eq('tenant_id', tenantId)
      .not('sku', 'is', null);
    if (wpErr) throw wpErr;

    // 4. Build a set of global attribute names for fast lookup
    const globalAttrNames = new Set(wcAttributes.map(a => a.name.toLowerCase()));

    // 5. For each WC product, fetch attributes and remove local duplicates of globals
    let productsFixed = 0;
    let totalDuplicatesRemoved = 0;
    const errors: { sku: string; error: string }[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < (wooProducts?.length ?? 0); i += BATCH_SIZE) {
      const batch = wooProducts!.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (wp) => {
        try {
          const productUrl = `${wooUrl}/wp-json/wc/v3/products/${wp.woo_id}?consumer_key=${ck}&consumer_secret=${cs}`;
          const pRes = await fetch(productUrl);
          if (!pRes.ok) return;
          const wcProduct = await pRes.json();

          const attrs: any[] = wcProduct.attributes || [];
          if (attrs.length === 0) return;

          // Find which global attrs exist (id > 0)
          const globalIds = new Map<string, any>();
          for (const a of attrs) {
            if (a.id > 0) {
              globalIds.set(a.name.toLowerCase(), a);
            }
          }

          // Filter out local (id:0) attrs that have a global counterpart
          const cleaned = attrs.filter((a: any) => {
            if (a.id === 0 && globalIds.has(a.name.toLowerCase())) {
              return false; // duplicate local — remove
            }
            return true;
          });

          const removed = attrs.length - cleaned.length;
          if (removed === 0) return;

          // Update WC product with cleaned attributes
          const updateUrl = `${wooUrl}/wp-json/wc/v3/products/${wp.woo_id}?consumer_key=${ck}&consumer_secret=${cs}`;
          const uRes = await fetch(updateUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attributes: cleaned }),
          });

          if (uRes.ok) {
            productsFixed++;
            totalDuplicatesRemoved += removed;
            console.log(`✓ [${wp.sku}] Removed ${removed} duplicate local attributes`);
          } else {
            const errText = await uRes.text();
            errors.push({ sku: wp.sku || 'unknown', error: `HTTP ${uRes.status}: ${errText.substring(0, 100)}` });
          }
        } catch (e: any) {
          errors.push({ sku: wp.sku || 'unknown', error: e.message });
        }
      }));

      // Rate limit between batches
      await new Promise(r => setTimeout(r, 500));
    }

    // 6. Log to changelog
    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'PURGE_DUPLICATE_ATTRS',
      description: `Purge: ${productsFixed} producten gefixt, ${totalDuplicatesRemoved} duplicaten verwijderd, ${refreshedCount} global attrs ververst`,
      metadata: {
        products_fixed: productsFixed,
        duplicates_removed: totalDuplicatesRemoved,
        global_attrs_refreshed: refreshedCount,
        errors: errors.slice(0, 20),
        total_wc_products_scanned: wooProducts?.length ?? 0,
      },
    });

    const result = {
      products_scanned: wooProducts?.length ?? 0,
      products_fixed: productsFixed,
      duplicates_removed: totalDuplicatesRemoved,
      global_attrs_refreshed: refreshedCount,
      errors: errors.slice(0, 20),
    };

    console.log('✓ Purge complete:', JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('Error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
