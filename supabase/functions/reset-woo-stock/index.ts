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

const BATCH_SIZE = 50; // Process 50 products per call

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    const { tenantId, startPage = 1 } = await req.json();

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    console.log(`Starting WooCommerce stock reset for tenant ${tenantId}, starting at page ${startPage}`);

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Failed to get tenant config: ${configError?.message}`);
    }

    const wooConfig: WooCommerceConfig = {
      url: tenantConfig.woocommerce_url,
      consumerKey: tenantConfig.woocommerce_consumer_key,
      consumerSecret: tenantConfig.woocommerce_consumer_secret,
    };

    // Fetch products for current batch
    const productsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
    productsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    productsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
    productsUrl.searchParams.append('per_page', BATCH_SIZE.toString());
    productsUrl.searchParams.append('page', startPage.toString());
    productsUrl.searchParams.append('type', 'variable');
    productsUrl.searchParams.append('status', 'any');

    const response = await fetchWithRetry(productsUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch products: ${response.status} - ${errorText}`);
    }

    const products = await response.json();
    const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1');
    const totalProducts = parseInt(response.headers.get('X-WP-Total') || '0');

    console.log(`Page ${startPage}/${totalPages}: ${products.length} products (total: ${totalProducts})`);

    if (!products || products.length === 0) {
      // No more products - log completion
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_STOCK_RESET_COMPLETE',
        description: `WooCommerce stock reset voltooid`,
        metadata: { totalProducts, completedAt: new Date().toISOString() },
      });

      return new Response(
        JSON.stringify({
          success: true,
          complete: true,
          message: 'Stock reset complete',
          totalProducts,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let variationsUpdated = 0;
    let errors = 0;

    // Process each product's variations synchronously
    for (const product of products) {
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
          errors++;
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
          variationsUpdated += updatedCount;
          console.log(`Product ${product.sku || product.id}: ${updatedCount} variations set to 0`);
        } else {
          console.error(`Failed to update product ${product.id}`);
          errors++;
        }

        // Small delay between products
        await new Promise(r => setTimeout(r, 300));

      } catch (error: any) {
        console.error(`Error processing product ${product.id}:`, error.message);
        errors++;
      }
    }

    const hasMorePages = startPage < totalPages;
    const nextPage = startPage + 1;

    // Log batch progress
    console.log(`Batch ${startPage}/${totalPages} complete: ${variationsUpdated} variations updated, ${errors} errors`);

    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_STOCK_RESET_BATCH',
      description: `Stock reset batch ${startPage}/${totalPages}: ${variationsUpdated} variaties op 0 gezet`,
      metadata: {
        page: startPage,
        totalPages,
        variationsUpdated,
        errors,
        hasMorePages,
        nextPage: hasMorePages ? nextPage : null,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        complete: !hasMorePages,
        page: startPage,
        totalPages,
        variationsUpdated,
        errors,
        nextPage: hasMorePages ? nextPage : null,
        message: hasMorePages 
          ? `Batch ${startPage}/${totalPages} complete. Call again with startPage=${nextPage} to continue.`
          : 'Stock reset complete',
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
