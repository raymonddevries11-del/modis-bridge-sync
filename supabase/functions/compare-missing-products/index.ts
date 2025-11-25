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

    console.log('Comparing database products with WooCommerce...');

    // Get all product SKUs from database
    const { data: dbProducts } = await supabase
      .from('products')
      .select('sku, title');

    console.log(`Found ${dbProducts?.length || 0} products in database`);

    // Get tenant config
    const { data: tenantConfig } = await supabase
      .from('tenant_config')
      .select('*')
      .limit(1)
      .single();

    if (!tenantConfig) {
      throw new Error('No tenant config found');
    }

    // Get ALL products from WooCommerce (including drafts, trash, etc.)
    const allWooProducts: any[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {  // Max 10 pages = 1000 products
      const url = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products`);
      url.searchParams.append('per_page', '100');
      url.searchParams.append('page', page.toString());
      url.searchParams.append('status', 'any');  // Get all statuses
      url.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
      url.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);

      const response = await fetch(url.toString());
      
      if (!response.ok) {
        console.error(`WooCommerce API error on page ${page}: ${response.status}`);
        break;
      }

      const products = await response.json();
      allWooProducts.push(...products);
      
      console.log(`Fetched page ${page}: ${products.length} products`);
      
      if (products.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    console.log(`Total WooCommerce products: ${allWooProducts.length}`);

    // Create SKU lookup
    const wooSkus = new Set(allWooProducts.map((p: any) => p.sku).filter(Boolean));
    
    // Find missing products
    const missingProducts = (dbProducts || []).filter(p => p.sku && !wooSkus.has(p.sku));
    const missingSkus = missingProducts.map(p => p.sku);

    console.log(`Missing products in WooCommerce: ${missingProducts.length}`);
    console.log('Missing SKUs:', missingSkus.slice(0, 10));

    return new Response(
      JSON.stringify({
        success: true,
        database_products: dbProducts?.length || 0,
        woocommerce_products: allWooProducts.length,
        missing_in_woocommerce: missingProducts.length,
        missing_skus: missingSkus,
        missing_products: missingProducts
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error comparing products:', error);
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
