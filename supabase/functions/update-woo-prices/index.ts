import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooCommerceConfig {
  url: string;
  consumerKey: string;
  consumerSecret: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    console.log('Starting WooCommerce price update...');

    // Get WooCommerce credentials
    const { data: config } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'woocommerce')
      .single();

    if (!config?.value) {
      throw new Error('WooCommerce configuration not found');
    }

    const wooConfig = config.value as WooCommerceConfig;

    // Fetch all products with prices and variants
    const { data: products, error } = await supabase
      .from('products')
      .select(`
        *,
        product_prices(*),
        variants(
          *,
          stock_totals(*)
        )
      `);

    if (error) throw error;
    if (!products || products.length === 0) {
      return new Response(JSON.stringify({ message: 'No products found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Found ${products.length} products in Supabase`);

    let updated = 0;
    let notFound = 0;
    let errors = 0;

    // Process each product
    for (const product of products) {
      try {
        const { sku, product_prices, variants } = product;
        
        // Find product in WooCommerce by SKU
        const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
        searchUrl.searchParams.append('sku', sku);
        searchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
        searchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
        
        const searchResponse = await fetch(searchUrl.toString());
        if (!searchResponse.ok) {
          console.error(`Failed to search for ${sku}: ${searchResponse.status}`);
          errors++;
          continue;
        }

        const wooProducts = await searchResponse.json();
        
        if (!wooProducts || wooProducts.length === 0) {
          console.log(`Product ${sku} not found in WooCommerce`);
          notFound++;
          continue;
        }

        const wooProductId = wooProducts[0].id;
        console.log(`Updating prices for ${sku} (WooCommerce ID: ${wooProductId})`);

        // Get all variations from WooCommerce
        const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
        variationsUrl.searchParams.append('per_page', '100');
        variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
        variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
        
        const variationsResponse = await fetch(variationsUrl.toString());
        if (!variationsResponse.ok) {
          console.error(`Failed to fetch variations for ${sku}`);
          errors++;
          continue;
        }

        const wooVariations = await variationsResponse.json();

        // Update each variation with prices and stock
        for (const wooVariation of wooVariations) {
          const sizeAttr = wooVariation.attributes?.find((attr: any) => 
            attr.name?.toLowerCase() === 'size'
          );
          
          if (!sizeAttr) continue;

          const sizeLabel = sizeAttr.option;
          
          // Find matching Supabase variant
          const supabaseVariant = variants?.find((v: any) => 
            v.size_label?.toLowerCase() === sizeLabel?.toLowerCase()
          );

          const updateData: any = {
            manage_stock: true,
            stock_quantity: supabaseVariant?.stock_totals?.qty || 0,
            stock_status: (supabaseVariant?.stock_totals?.qty || 0) > 0 ? 'instock' : 'outofstock',
          };

          // Add prices
          if (product_prices?.regular) {
            updateData.regular_price = product_prices.regular.toString();
          }
          if (product_prices?.list) {
            updateData.sale_price = product_prices.list.toString();
          }

          // Update the variation
          const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/${wooVariation.id}`);
          updateUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
          updateUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
          
          const updateResponse = await fetch(updateUrl.toString(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData),
          });

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error(`Failed to update variation ${sizeLabel} for ${sku}: ${errorText}`);
          } else {
            console.log(`✓ Updated ${sku} size ${sizeLabel}: €${updateData.regular_price} (stock: ${updateData.stock_quantity})`);
          }
        }

        updated++;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        console.error(`Error processing product ${product.sku}:`, err);
        errors++;
      }
    }

    const result = {
      success: true,
      total: products.length,
      updated,
      notFound,
      errors,
      message: `Updated ${updated} products. ${notFound} not found in WooCommerce. ${errors} errors.`
    };

    console.log('Price update complete:', result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
