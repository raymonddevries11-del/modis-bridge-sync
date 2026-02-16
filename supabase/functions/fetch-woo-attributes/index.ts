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

    // Fetch all global product attributes
    const attrsUrl = `${wooUrl}/wp-json/wc/v3/products/attributes?consumer_key=${ck}&consumer_secret=${cs}&per_page=100`;
    const attrsRes = await fetch(attrsUrl);
    if (!attrsRes.ok) throw new Error(`WC API error: ${attrsRes.status}`);
    const attributes = await attrsRes.json();

    // For each attribute, fetch its terms
    const result = [];
    for (const attr of attributes) {
      const termsUrl = `${wooUrl}/wp-json/wc/v3/products/attributes/${attr.id}/terms?consumer_key=${ck}&consumer_secret=${cs}&per_page=100`;
      let terms: { id: number; name: string; slug: string; count: number }[] = [];
      try {
        const termsRes = await fetch(termsUrl);
        if (termsRes.ok) {
          terms = await termsRes.json();
        }
      } catch (e) {
        console.error(`Error fetching terms for ${attr.name}:`, e);
      }

      result.push({
        id: attr.id,
        name: attr.name,
        slug: attr.slug,
        type: attr.type,
        termCount: terms.length,
        terms: terms.map(t => ({ id: t.id, name: t.name, slug: t.slug, count: t.count })),
      });

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    return new Response(
      JSON.stringify({ attributes: result, total: result.length }),
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
