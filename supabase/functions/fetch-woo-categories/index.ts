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

    const { data: config } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();
    if (!config) throw new Error('No tenant config found');

    const wooUrl = config.woocommerce_url.replace(/\/$/, '');
    const ck = config.woocommerce_consumer_key;
    const cs = config.woocommerce_consumer_secret;

    // Fetch all categories with pagination
    const allCategories: { id: number; name: string; slug: string; parent: number; count: number }[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const url = `${wooUrl}/wp-json/wc/v3/products/categories?consumer_key=${ck}&consumer_secret=${cs}&per_page=${perPage}&page=${page}&_fields=id,name,slug,parent,count`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`WC API error: ${res.status}`);
      
      const cats = await res.json();
      if (!Array.isArray(cats) || cats.length === 0) break;
      
      allCategories.push(...cats);
      if (cats.length < perPage) break;
      page++;
    }

    // Build hierarchical names (Parent > Child)
    const catMap = new Map(allCategories.map(c => [c.id, c]));
    const result = allCategories.map(c => {
      let fullName = c.name;
      let current = c;
      while (current.parent > 0) {
        const parent = catMap.get(current.parent);
        if (!parent) break;
        fullName = `${parent.name} > ${fullName}`;
        current = parent;
      }
      return { id: c.id, name: c.name, slug: c.slug, fullName, count: c.count };
    }).sort((a, b) => a.fullName.localeCompare(b.fullName));

    return new Response(
      JSON.stringify({ categories: result, total: result.length }),
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
