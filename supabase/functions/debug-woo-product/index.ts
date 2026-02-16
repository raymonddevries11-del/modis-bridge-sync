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
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { sku, tenantId } = await req.json();

    if (!sku || !tenantId) {
      throw new Error("sku and tenantId are required");
    }

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabaseClient
      .from("tenant_config")
      .select("*")
      .eq("tenant_id", tenantId)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Failed to get tenant config: ${configError?.message}`);
    }

    // Search for product by SKU
    const searchUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products`);
    searchUrl.searchParams.append("consumer_key", tenantConfig.woocommerce_consumer_key);
    searchUrl.searchParams.append("consumer_secret", tenantConfig.woocommerce_consumer_secret);
    searchUrl.searchParams.append("sku", sku);

    const searchResponse = await fetch(searchUrl.toString());
    
    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      throw new Error(`WooCommerce search failed: ${searchResponse.status} - ${errorText}`);
    }

    const products = await searchResponse.json();
    
    if (!products || products.length === 0) {
      return new Response(
        JSON.stringify({ error: "Product not found", sku }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const product = products[0];

    // Get variations
    const variationsUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/${product.id}/variations`);
    variationsUrl.searchParams.append("consumer_key", tenantConfig.woocommerce_consumer_key);
    variationsUrl.searchParams.append("consumer_secret", tenantConfig.woocommerce_consumer_secret);
    variationsUrl.searchParams.append("per_page", "100");

    const variationsResponse = await fetch(variationsUrl.toString());
    const variations = variationsResponse.ok ? await variationsResponse.json() : [];

    // Return full attribute data for debugging
    return new Response(
      JSON.stringify({
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        permalink: product.permalink,
        type: product.type,
        status: product.status,
        attributes: product.attributes,
        variationCount: variations.length,
        variations: variations.map((v: any) => ({
          id: v.id,
          sku: v.sku,
          attributes: v.attributes,
          stock_quantity: v.stock_quantity,
          stock_status: v.stock_status
        }))
      }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error("Error:", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
