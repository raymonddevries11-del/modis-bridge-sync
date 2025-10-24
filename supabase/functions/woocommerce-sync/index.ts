import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooCommerceConfig {
  url: string;
  consumer_key: string;
  consumer_secret: string;
}

interface SyncJob {
  id: string;
  payload: {
    productIds?: string[];
    variantIds?: string[];
  };
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
    console.log('Starting WooCommerce sync job consumer...');

    // Fetch ready jobs with FOR UPDATE SKIP LOCKED (single consumer pattern)
    const { data: jobs, error: jobError } = await supabase
      .from('jobs')
      .select('*')
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'ready')
      .limit(10);

    if (jobError) {
      console.error('Error fetching jobs:', jobError);
      throw jobError;
    }

    if (!jobs || jobs.length === 0) {
      console.log('No pending sync jobs found');
      return new Response(JSON.stringify({ message: 'No jobs to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Processing ${jobs.length} sync jobs`);

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
    const wooAuth = btoa(`${wooConfig.consumer_key}:${wooConfig.consumer_secret}`);

    // Process each job
    const results = await Promise.allSettled(
      jobs.map((job) => processJob(job, wooConfig, wooAuth, supabase))
    );

    const successCount = results.filter((r) => r.status === 'fulfilled').length;
    const failureCount = results.filter((r) => r.status === 'rejected').length;

    console.log(`Sync complete: ${successCount} succeeded, ${failureCount} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: jobs.length,
        succeeded: successCount,
        failed: failureCount,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('WooCommerce sync error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function processJob(
  job: SyncJob,
  wooConfig: WooCommerceConfig,
  wooAuth: string,
  supabase: any
) {
  console.log(`Processing job ${job.id}`, job.payload);

  // Mark as processing
  await supabase
    .from('jobs')
    .update({ state: 'processing', attempts: (job as any).attempts + 1 })
    .eq('id', job.id);

  try {
    const { productIds, variantIds } = job.payload;

    // Fetch products with their prices and variants
    let query = supabase
      .from('products')
      .select(`
        *,
        product_prices(*),
        variants(
          *,
          stock_totals(*)
        )
      `);

    if (productIds && productIds.length > 0) {
      query = query.in('id', productIds);
    } else if (variantIds && variantIds.length > 0) {
      // If only variant IDs, fetch their parent products
      const { data: variantData } = await supabase
        .from('variants')
        .select('product_id')
        .in('id', variantIds);
      
      if (variantData && variantData.length > 0) {
        const parentIds = [...new Set(variantData.map((v: any) => v.product_id))];
        query = query.in('id', parentIds);
      }
    }

    const { data: products, error: productsError } = await query;

    if (productsError) throw productsError;
    if (!products || products.length === 0) {
      console.log('No products found for sync');
      await supabase.from('jobs').update({ state: 'done' }).eq('id', job.id);
      return;
    }

    console.log(`Syncing ${products.length} products to WooCommerce`);

    // Process each product
    for (const product of products) {
      await syncProductToWooCommerce(product, wooConfig, wooAuth, variantIds);
    }

    // Mark as done
    await supabase.from('jobs').update({ state: 'done', error: null }).eq('id', job.id);
    console.log(`Job ${job.id} completed successfully`);
  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStatus = (error as any)?.status;
    const attempts = (job as any).attempts + 1;
    const maxRetries = 5;

    // Check if we should retry
    const shouldRetry = 
      attempts < maxRetries && 
      (errorStatus === 429 || (errorStatus >= 500 && errorStatus < 600));

    if (shouldRetry) {
      // Exponential backoff: reset to ready for retry
      const backoffSeconds = Math.pow(2, attempts); // 1, 2, 4, 8, 16 seconds
      console.log(`Retrying job ${job.id} in ${backoffSeconds}s (attempt ${attempts}/${maxRetries})`);
      
      await supabase
        .from('jobs')
        .update({ 
          state: 'ready', 
          error: `Retry ${attempts}/${maxRetries}: ${errorMessage}` 
        })
        .eq('id', job.id);
    } else {
      // Permanent failure
      await supabase
        .from('jobs')
        .update({ 
          state: 'error', 
          error: errorMessage 
        })
        .eq('id', job.id);
    }

    throw error;
  }
}

async function syncProductToWooCommerce(
  product: any,
  wooConfig: WooCommerceConfig,
  wooAuth: string,
  variantIdsFilter?: string[]
) {
  const { sku, product_prices, variants } = product;

  // Find WooCommerce product by SKU - use query params for auth instead of Basic Auth
  const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
  searchUrl.searchParams.append('sku', sku);
  searchUrl.searchParams.append('consumer_key', wooConfig.consumer_key);
  searchUrl.searchParams.append('consumer_secret', wooConfig.consumer_secret);
  
  const searchResponse = await fetchWithRetry(searchUrl.toString(), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!searchResponse.ok) {
    if (searchResponse.status === 401) {
      throw new Error(`WooCommerce authentication failed. Check your API credentials.`);
    }
    throw new Error(`Failed to search for product ${sku}: ${searchResponse.status} ${searchResponse.statusText}`);
  }

  const wooProducts = await searchResponse.json();
  if (!wooProducts || wooProducts.length === 0) {
    console.log(`Product ${sku} not found in WooCommerce, skipping sync`);
    return;
  }

  const wooProduct = wooProducts[0];
  const wooProductId = wooProduct.id;

  console.log(`Found WooCommerce product ID ${wooProductId} for SKU ${sku}`);

  // Update product prices
  if (product_prices) {
    const priceUpdateData: any = {};
    
    if (product_prices.regular) {
      priceUpdateData.regular_price = product_prices.regular.toString();
    }
    if (product_prices.list) {
      priceUpdateData.sale_price = product_prices.list.toString();
    }

    if (Object.keys(priceUpdateData).length > 0) {
      const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
      updateUrl.searchParams.append('consumer_key', wooConfig.consumer_key);
      updateUrl.searchParams.append('consumer_secret', wooConfig.consumer_secret);
      
      const updateResponse = await fetchWithRetry(updateUrl.toString(), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(priceUpdateData),
      });

      if (!updateResponse.ok) {
        throw new Error(`Failed to update product prices: ${updateResponse.statusText}`);
      }

      console.log(`Updated prices for product ${sku}`);
    }
  }

  // Update variants (WooCommerce variations)
  if (variants && variants.length > 0) {
    const variantsToSync = variantIdsFilter 
      ? variants.filter((v: any) => variantIdsFilter.includes(v.id))
      : variants;

    for (const variant of variantsToSync) {
      await syncVariantToWooCommerce(
        wooProductId,
        variant,
        wooConfig,
        wooAuth
      );
    }
  }
}

async function syncVariantToWooCommerce(
  wooProductId: number,
  variant: any,
  wooConfig: WooCommerceConfig,
  wooAuth: string
) {
  // Find WooCommerce variation by size attribute
  const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
  variationsUrl.searchParams.append('per_page', '100');
  variationsUrl.searchParams.append('consumer_key', wooConfig.consumer_key);
  variationsUrl.searchParams.append('consumer_secret', wooConfig.consumer_secret);
  
  const variationsResponse = await fetchWithRetry(variationsUrl.toString(), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!variationsResponse.ok) {
    console.error(`Failed to fetch variations for product ${wooProductId}`);
    return;
  }

  const wooVariations = await variationsResponse.json();
  
  // Find matching variation by size label
  const matchingVariation = wooVariations.find((v: any) => 
    v.attributes?.some((attr: any) => 
      attr.name?.toLowerCase() === 'size' && 
      attr.option?.toLowerCase() === variant.size_label?.toLowerCase()
    )
  );

  if (!matchingVariation) {
    console.log(`No matching WooCommerce variation found for size ${variant.size_label}`);
    return;
  }

  console.log(`Updating WooCommerce variation ${matchingVariation.id} for size ${variant.size_label}`);

  // Prepare update data
  const updateData: any = {
    stock_quantity: variant.stock_totals?.qty || 0,
    manage_stock: true,
    stock_status: (variant.stock_totals?.qty || 0) > 0 ? 'instock' : 'outofstock',
  };

  // Add EAN to meta_data
  if (variant.ean) {
    updateData.meta_data = [
      { key: 'ean', value: variant.ean }
    ];
  }

  const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/${matchingVariation.id}`);
  updateUrl.searchParams.append('consumer_key', wooConfig.consumer_key);
  updateUrl.searchParams.append('consumer_secret', wooConfig.consumer_secret);
  
  const updateResponse = await fetchWithRetry(updateUrl.toString(), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updateData),
  });

  if (!updateResponse.ok) {
    throw new Error(`Failed to update variation: ${updateResponse.statusText}`);
  }

  console.log(`Updated stock for variation ${variant.size_label}: ${updateData.stock_quantity}`);
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
        
        console.log(`Rate limited, waiting ${waitTime}ms before retry ${attempt}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Handle server errors with retry
      if (response.status >= 500 && response.status < 600) {
        if (attempt < maxRetries) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Server error ${response.status}, retrying in ${waitTime}ms (${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');
      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.log(`Request failed, retrying in ${waitTime}ms (${attempt}/${maxRetries}):`, errorMsg);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  throw lastError || new Error('Max retries exceeded');
}
