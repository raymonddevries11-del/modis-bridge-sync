import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get tenant config
    const { data: tenantConfig } = await supabase
      .from('tenant_config')
      .select('*')
      .limit(1)
      .single();

    if (!tenantConfig) {
      throw new Error('No tenant config found');
    }

    // Count products in WooCommerce
    const url = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products`);
    url.searchParams.append('per_page', '1');
    url.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
    url.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      throw new Error(`WooCommerce API error: ${response.status}`);
    }

    // Get total from headers
    const totalProducts = response.headers.get('X-WP-Total');
    const totalPages = response.headers.get('X-WP-TotalPages');

    return new Response(
      JSON.stringify({
        success: true,
        woocommerce_products: parseInt(totalProducts || '0'),
        total_pages: parseInt(totalPages || '0')
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error counting WooCommerce products:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
