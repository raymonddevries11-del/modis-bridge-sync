// Sync WooCommerce global attributes + terms → woo_global_attributes cache
// Also auto-maps PIM attributes by matching names/slugs
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { tenantId } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    // 1. Get WooCommerce credentials
    const { data: config } = await supabase
      .from('tenant_config')
      .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
      .eq('tenant_id', tenantId)
      .single();
    if (!config) throw new Error('No tenant config found');

    const wooBase = config.woocommerce_url.replace(/\/$/, '');
    const auth = `consumer_key=${config.woocommerce_consumer_key}&consumer_secret=${config.woocommerce_consumer_secret}`;

    // 2. Fetch all global attributes
    const attrsRes = await fetch(`${wooBase}/wp-json/wc/v3/products/attributes?per_page=100&${auth}`);
    if (!attrsRes.ok) throw new Error(`WC API error: ${attrsRes.status}`);
    const attributes = await attrsRes.json();

    // 3. Fetch PIM attribute definitions for auto-mapping
    const { data: pimDefs } = await supabase
      .from('attribute_definitions')
      .select('name')
      .order('sort_order');
    const pimNames = new Set((pimDefs || []).map((d: any) => d.name.toLowerCase()));

    // 4. For each attribute, fetch its terms and upsert
    const results: any[] = [];
    for (const attr of attributes) {
      // Fetch terms (paginate up to 300)
      const allTerms: any[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const termsRes = await fetch(
          `${wooBase}/wp-json/wc/v3/products/attributes/${attr.id}/terms?per_page=100&page=${page}&${auth}`
        );
        if (!termsRes.ok) break;
        const terms = await termsRes.json();
        if (!Array.isArray(terms) || terms.length === 0) break;
        allTerms.push(...terms.map((t: any) => ({
          id: t.id, name: t.name, slug: t.slug, count: t.count || 0,
        })));
        hasMore = terms.length === 100;
        page++;
        await new Promise(r => setTimeout(r, 200));
      }

      // Auto-map: check if WC attribute name matches a PIM attribute name
      const cleanSlug = (attr.slug || '').replace(/^pa_/, '');
      let pimMatch: string | null = null;
      if (pimNames.has(attr.name.toLowerCase())) {
        pimMatch = attr.name;
      } else if (pimNames.has(cleanSlug.toLowerCase())) {
        // Find exact PIM name by case-insensitive match
        pimMatch = (pimDefs || []).find((d: any) => d.name.toLowerCase() === cleanSlug.toLowerCase())?.name || null;
      }

      // Upsert into cache
      const { error } = await supabase
        .from('woo_global_attributes')
        .upsert({
          tenant_id: tenantId,
          woo_attr_id: attr.id,
          name: attr.name,
          slug: attr.slug || `pa_${cleanSlug}`,
          pim_attribute_name: pimMatch,
          terms: allTerms,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,woo_attr_id' });

      if (error) {
        console.error(`Failed to upsert attribute ${attr.name}:`, error.message);
      }

      results.push({
        woo_attr_id: attr.id,
        name: attr.name,
        slug: attr.slug,
        pim_mapped: pimMatch,
        term_count: allTerms.length,
      });

      await new Promise(r => setTimeout(r, 200));
    }

    // 5. Log to changelog
    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_ATTR_CACHE_SYNC',
      description: `WooCommerce attributen gecached: ${results.length} attributen, ${results.filter(r => r.pim_mapped).length} auto-mapped naar PIM`,
      metadata: { attributes: results },
    });

    console.log(`Synced ${results.length} WC global attributes for tenant ${tenantId}`);

    return new Response(JSON.stringify({
      success: true,
      total: results.length,
      mapped: results.filter(r => r.pim_mapped).length,
      attributes: results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error('Error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
