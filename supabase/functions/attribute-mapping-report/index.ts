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
    const url = new URL(req.url);
    let tenantId = url.searchParams.get('tenant_id');

    // Also accept tenant_id from POST body
    if (!tenantId && req.method === 'POST') {
      try {
        const body = await req.json();
        tenantId = body.tenant_id || null;
      } catch { /* ignore parse errors */ }
    }

    if (!tenantId) {
      return new Response(JSON.stringify({ error: 'tenant_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 1. Fetch all WC global attributes for tenant (the "mapped" side)
    const { data: globalAttrs } = await supabase
      .from('woo_global_attributes')
      .select('name, slug, woo_attr_id, pim_attribute_name, terms')
      .eq('tenant_id', tenantId);

    // Build lookup: pim_attribute_name OR name → global attr info
    const mappedPimKeys = new Map<string, {
      wc_name: string; wc_id: number; slug: string;
      term_count: number; sample_terms: string[];
    }>();

    for (const ga of (globalAttrs || [])) {
      const pimKey = ga.pim_attribute_name || ga.name;
      const terms = Array.isArray(ga.terms) ? ga.terms : [];
      mappedPimKeys.set(pimKey.toLowerCase(), {
        wc_name: ga.name,
        wc_id: ga.woo_attr_id,
        slug: ga.slug,
        term_count: terms.length,
        sample_terms: terms.slice(0, 5).map((t: any) => t.name || t.slug || String(t)),
      });
    }

    // 2. Scan product attributes to find all distinct PIM keys + sample values
    const pimAttrStats = new Map<string, { count: number; sample_values: Set<string> }>();
    let offset = 0;
    const BATCH = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('products')
        .select('attributes')
        .eq('tenant_id', tenantId)
        .not('attributes', 'is', null)
        .range(offset, offset + BATCH - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const p of data) {
        const attrs = p.attributes as Record<string, any> | null;
        if (!attrs) continue;
        for (const [key, val] of Object.entries(attrs)) {
          if (!key || key === '-') continue;
          const stat = pimAttrStats.get(key) || { count: 0, sample_values: new Set<string>() };
          stat.count++;
          if (val && typeof val === 'string' && val.trim() && stat.sample_values.size < 5) {
            stat.sample_values.add(val.trim().substring(0, 80));
          }
          pimAttrStats.set(key, stat);
        }
      }

      if (data.length < BATCH) break;
      offset += BATCH;
    }

    // 3. Build report
    const mapped: any[] = [];
    const unmapped: any[] = [];

    for (const [pimKey, stat] of pimAttrStats.entries()) {
      const match = mappedPimKeys.get(pimKey.toLowerCase());
      if (match) {
        mapped.push({
          pim_key: pimKey,
          wc_name: match.wc_name,
          wc_id: match.wc_id,
          wc_slug: match.slug,
          product_count: stat.count,
          wc_term_count: match.term_count,
          sample_pim_values: Array.from(stat.sample_values),
          sample_wc_terms: match.sample_terms,
        });
      } else {
        unmapped.push({
          pim_key: pimKey,
          product_count: stat.count,
          sample_values: Array.from(stat.sample_values),
        });
      }
    }

    // Sort by product_count desc
    mapped.sort((a, b) => b.product_count - a.product_count);
    unmapped.sort((a, b) => b.product_count - a.product_count);

    const report = {
      tenant_id: tenantId,
      generated_at: new Date().toISOString(),
      summary: {
        total_pim_attributes: pimAttrStats.size,
        mapped_count: mapped.length,
        unmapped_count: unmapped.length,
        coverage_pct: pimAttrStats.size > 0
          ? Math.round((mapped.length / pimAttrStats.size) * 100)
          : 0,
      },
      mapped,
      unmapped,
    };

    // 4. Store report snapshot in config for dashboard access
    await supabase
      .from('config')
      .upsert({
        key: `attr_mapping_report_${tenantId}`,
        value: report,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

    return new Response(JSON.stringify(report), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('attribute-mapping-report error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
