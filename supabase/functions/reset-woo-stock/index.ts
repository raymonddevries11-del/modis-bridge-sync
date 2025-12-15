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

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // Rate limiting - wait and retry
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '5');
        console.log(`Rate limited, waiting ${retryAfter}s before retry ${attempt}/${maxRetries}`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      
      return response;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`Request failed, retrying ${attempt}/${maxRetries}:`, error);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Max retries exceeded');
}

async function runStockReset(tenantId: string, supabase: any) {
  console.log(`Starting WooCommerce stock reset for tenant ${tenantId}`);

  // Get tenant config
  const { data: tenantConfig, error: configError } = await supabase
    .from('tenant_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .single();

  if (configError || !tenantConfig) {
    console.error(`Failed to get tenant config: ${configError?.message}`);
    return;
  }

  const wooConfig: WooCommerceConfig = {
    url: tenantConfig.woocommerce_url,
    consumerKey: tenantConfig.woocommerce_consumer_key,
    consumerSecret: tenantConfig.woocommerce_consumer_secret,
  };

  // Fetch all products from WooCommerce (paginated)
  let allProducts: any[] = [];
  let page = 1;
  const perPage = 100;

  console.log('Fetching all products from WooCommerce...');

  while (true) {
    const productsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
    productsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    productsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
    productsUrl.searchParams.append('per_page', perPage.toString());
    productsUrl.searchParams.append('page', page.toString());
    productsUrl.searchParams.append('type', 'variable');
    productsUrl.searchParams.append('status', 'any');

    const response = await fetchWithRetry(productsUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch products: ${response.status} - ${errorText}`);
      break;
    }

    const products = await response.json();
    
    if (!products || products.length === 0) {
      break;
    }

    allProducts = allProducts.concat(products);
    console.log(`Fetched page ${page}: ${products.length} products (total: ${allProducts.length})`);

    if (products.length < perPage) {
      break;
    }

    page++;
  }

  console.log(`Total products to process: ${allProducts.length}`);

  let totalVariationsUpdated = 0;
  let totalErrors = 0;
  const errorDetails: string[] = [];

  // Process each product's variations
  for (let i = 0; i < allProducts.length; i++) {
    const product = allProducts[i];
    
    try {
      // Fetch all variations for this product
      const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${product.id}/variations`);
      variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
      variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
      variationsUrl.searchParams.append('per_page', '100');

      const variationsResponse = await fetchWithRetry(variationsUrl.toString(), {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!variationsResponse.ok) {
        console.error(`Failed to fetch variations for product ${product.id}`);
        totalErrors++;
        continue;
      }

      const variations = await variationsResponse.json();

      if (!variations || variations.length === 0) {
        continue;
      }

      // Filter variations that have stock > 0
      const variationsWithStock = variations.filter((v: any) => 
        (v.stock_quantity && v.stock_quantity > 0) || v.stock_status === 'instock'
      );

      if (variationsWithStock.length === 0) {
        continue;
      }

      // Batch update all variations to stock = 0
      const batchPayload = {
        update: variationsWithStock.map((v: any) => ({
          id: v.id,
          stock_quantity: 0,
          stock_status: 'outofstock',
          manage_stock: true,
        })),
      };

      const batchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${product.id}/variations/batch`);
      batchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
      batchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

      const batchResponse = await fetchWithRetry(batchUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchPayload),
      });

      if (batchResponse.ok) {
        const result = await batchResponse.json();
        const updatedCount = result.update?.length || 0;
        totalVariationsUpdated += updatedCount;
        console.log(`Product ${product.sku || product.id}: ${updatedCount} variations set to 0`);
      } else {
        const errorText = await batchResponse.text();
        console.error(`Failed to update product ${product.id}: ${errorText}`);
        totalErrors++;
        errorDetails.push(`Product ${product.sku || product.id}: ${errorText.substring(0, 100)}`);
      }

      // Small delay between products to avoid rate limiting
      if (i < allProducts.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }

    } catch (error: any) {
      console.error(`Error processing product ${product.id}:`, error.message);
      totalErrors++;
      errorDetails.push(`Product ${product.sku || product.id}: ${error.message}`);
    }
  }

  // Log to changelog
  await supabase.from('changelog').insert({
    tenant_id: tenantId,
    event_type: 'WOO_STOCK_RESET',
    description: `Alle WooCommerce voorraad op 0 gezet: ${totalVariationsUpdated} variaties geüpdatet`,
    metadata: {
      totalProducts: allProducts.length,
      totalVariationsUpdated,
      totalErrors,
      errorDetails: errorDetails.slice(0, 10),
    },
  });

  console.log(`Stock reset complete: ${totalVariationsUpdated} variations updated, ${totalErrors} errors`);
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
    const { tenantId } = await req.json();

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    // Start background processing using Supabase EdgeRuntime
    (globalThis as any).EdgeRuntime?.waitUntil?.(runStockReset(tenantId, supabase)) 
      ?? runStockReset(tenantId, supabase).catch(console.error);

    // Return immediate response
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Stock reset started in background. Check logs for progress.',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Stock reset error:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
