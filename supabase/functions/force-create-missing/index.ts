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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get ONE missing product
    const { data: product } = await supabase
      .from('products')
      .select('*, variants(*)')
      .eq('sku', '187069007000')
      .single();

    if (!product) {
      throw new Error('Product not found');
    }

    // Get tenant config
    const { data: config } = await supabase
      .from('tenant_config')
      .select('*')
      .limit(1)
      .single();

    if (!config) {
      throw new Error('Config not found');
    }

    // Create product in WooCommerce
    const sizeOptions = product.variants?.map((v: any) => v.size_label) || [];
    
    const productData = {
      name: product.title,
      type: 'variable',
      sku: product.sku,
      status: 'publish',
      catalog_visibility: 'visible',
      description: product.webshop_text || '',
      attributes: [{
        name: 'Size',
        position: 0,
        visible: true,
        variation: true,
        options: sizeOptions
      }]
    };

    const url = new URL(`${config.woocommerce_url}/wp-json/wc/v3/products`);
    url.searchParams.append('consumer_key', config.woocommerce_consumer_key);
    url.searchParams.append('consumer_secret', config.woocommerce_consumer_secret);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(productData),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('WooCommerce error:', result);
      throw new Error(`WooCommerce API error: ${JSON.stringify(result)}`);
    }

    console.log('Successfully created product:', result.id);

    return new Response(
      JSON.stringify({
        success: true,
        woo_product_id: result.id,
        sku: product.sku,
        result: result
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error:', error);
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
