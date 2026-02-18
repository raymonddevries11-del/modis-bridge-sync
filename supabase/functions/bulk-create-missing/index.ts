import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MISSING_SKUS = [
  '216618602000', '586619002000', '233678103000', '579612005000',
  '233456801000', '260529013000', '274524202000', '233519003000', 
  '252774101000', '270524202000', '274529001000', '231549005000', 
  '232379009000', '257768102000', '271529005000', '270529009000', 
  '287459001000', '271523002000', '273529006000', '473174205000', 
  '274523001000', '335179106000', '287793101000', '333179022000', 
  '335178117000'
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Creating ${MISSING_SKUS.length} missing products...`);

    // Get all missing products
    const { data: products } = await supabase
      .from('products')
      .select('*, variants(*)')
      .in('sku', MISSING_SKUS);

    if (!products || products.length === 0) {
      throw new Error('No products found');
    }

    console.log(`Found ${products.length} products to create`);

    // Get tenant config
    const { data: config } = await supabase
      .from('tenant_config')
      .select('*')
      .limit(1)
      .single();

    if (!config) {
      throw new Error('Config not found');
    }

    const results = [];
    let created = 0;
    let failed = 0;

    // Create each product
    for (const product of products) {
      try {
        // Skip products without title
        if (!product.title || product.title.trim() === '') {
          console.log(`Skipping product ${product.sku} - no title`);
          failed++;
          results.push({ sku: product.sku, error: 'No title' });
          continue;
        }

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

        if (response.ok) {
          console.log(`✓ Created ${product.sku} - WooCommerce ID: ${result.id}`);
          created++;
          results.push({ sku: product.sku, success: true, woo_id: result.id });

          // Cache invalidation: upsert woo_products so sync-new-products won't re-queue
          await supabase.from('woo_products').upsert({
            tenant_id: product.tenant_id, woo_id: result.id, product_id: product.id,
            sku: product.sku, name: product.title, slug: result.slug || '',
            status: result.status || 'publish', type: result.type || 'variable',
            last_pushed_at: new Date().toISOString(),
          }, { onConflict: 'tenant_id,woo_id' });
        } else {
          console.error(`✗ Failed ${product.sku}:`, result.message);
          failed++;
          results.push({ sku: product.sku, error: result.message || 'Unknown error' });
        }

        // Small delay to avoid overwhelming WooCommerce
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`✗ Error creating ${product.sku}:`, errorMessage);
        failed++;
        results.push({ sku: product.sku, error: errorMessage });
      }
    }

    console.log(`Completed: ${created} created, ${failed} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        created,
        failed,
        total: products.length,
        results
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
