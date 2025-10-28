import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooCommerceConfig {
  url: string;
  consumerKey: string;
  consumerSecret: string;
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

    // Check if a specific job ID was provided in the request
    let jobs;
    const body = await req.json().catch(() => ({}));
    
    if (body.jobId) {
      // Process specific job (called by job-scheduler)
      console.log(`Processing specific job: ${body.jobId}`);
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('id', body.jobId)
        .eq('type', 'SYNC_TO_WOO')
        .in('state', ['ready', 'processing'])
        .single();
      
      if (error || !data) {
        console.log(`Job ${body.jobId} not found or not processable`, error);
        return new Response(JSON.stringify({ message: 'Job not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      jobs = [data];
    } else {
      // Fetch ready jobs with FOR UPDATE SKIP LOCKED (single consumer pattern)
      const { data, error: jobError } = await supabase
        .from('jobs')
        .select('*')
        .eq('type', 'SYNC_TO_WOO')
        .eq('state', 'ready')
        .limit(10);

      if (jobError) {
        console.error('Error fetching jobs:', jobError);
        throw jobError;
      }
      jobs = data || [];
    }

    if (!jobs || jobs.length === 0) {
      console.log('No pending sync jobs found');
      return new Response(JSON.stringify({ message: 'No jobs to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Processing ${jobs.length} sync jobs`);

    // Process each job (each job now has its own tenant configuration)
    const results = await Promise.allSettled(
      jobs.map((job) => processJob(job, supabase))
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
  job: any,
  supabase: any
) {
  console.log(`Processing job ${job.id}`, job.payload);

  // Mark as processing
  await supabase
    .from('jobs')
    .update({ state: 'processing', attempts: (job as any).attempts + 1 })
    .eq('id', job.id);

  try {
    // Get tenant-specific WooCommerce config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', job.tenant_id)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Tenant configuration not found for job ${job.id}`);
    }

    const wooConfig = {
      url: tenantConfig.woocommerce_url,
      consumerKey: tenantConfig.woocommerce_consumer_key,
      consumerSecret: tenantConfig.woocommerce_consumer_secret,
    } as WooCommerceConfig;
    const { productIds, variantIds } = job.payload;

    // Limit batch size to prevent timeouts
    const BATCH_SIZE = 10;
    let productIdsToProcess = productIds || [];
    
    // If we have more products than batch size, split the job
    if (productIdsToProcess.length > BATCH_SIZE) {
      const currentBatch = productIdsToProcess.slice(0, BATCH_SIZE);
      const remainingIds = productIdsToProcess.slice(BATCH_SIZE);
      
      // Create a new job for remaining products
      console.log(`Splitting job: processing ${currentBatch.length} now, ${remainingIds.length} in new job`);
      await supabase.from('jobs').insert({
        type: 'SYNC_TO_WOO',
        tenant_id: job.tenant_id,
        state: 'ready',
        payload: {
          productIds: remainingIds,
          variantIds: variantIds
        }
      });
      
      productIdsToProcess = currentBatch;
    }

    // Fetch products with their prices and variants (filtered by tenant)
    let query = supabase
      .from('products')
      .select(`
        *,
        product_prices(*),
        variants(
          *,
          stock_totals(*)
        )
      `)
      .eq('tenant_id', job.tenant_id);

    if (productIdsToProcess && productIdsToProcess.length > 0) {
      query = query.in('id', productIdsToProcess);
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
      await syncProductToWooCommerce(product, wooConfig, variantIds);
    }

    // Mark as done and log to changelog
    await supabase.from('jobs').update({ state: 'done', error: null }).eq('id', job.id);
    
    // Add changelog entry
    await supabase.from('changelog').insert({
      tenant_id: job.tenant_id,
      event_type: 'SYNC_COMPLETED',
      description: `${products.length} producten gesynchroniseerd naar WooCommerce`,
      metadata: {
        productCount: products.length,
        jobId: job.id
      }
    });
    
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
      
      // Log failed sync to changelog
      await supabase.from('changelog').insert({
        tenant_id: job.tenant_id,
        event_type: 'SYNC_FAILED',
        description: `WooCommerce synchronisatie mislukt na ${maxRetries} pogingen`,
        metadata: {
          error: errorMessage,
          attempts: attempts,
          jobId: job.id
        }
      });
    }

    throw error;
  }
}

async function syncProductToWooCommerce(
  product: any,
  wooConfig: WooCommerceConfig,
  variantIdsFilter?: string[]
) {
  const { sku, title, product_prices, variants, images, color, brands } = product;

  console.log(`Syncing product ${sku}`);

  // Find WooCommerce product by SKU
  const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
  searchUrl.searchParams.append('sku', sku);
  searchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  searchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
  
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
  
  // If product doesn't exist, create it
  if (!wooProducts || wooProducts.length === 0) {
    console.log(`Product ${sku} not found in WooCommerce, creating new product`);
    await createProductInWooCommerce(product, wooConfig, variantIdsFilter);
    return;
  }

  // Product exists, update it
  const wooProduct = wooProducts[0];
  const wooProductId = wooProduct.id;
  console.log(`Found WooCommerce product ID ${wooProductId} for SKU ${sku}, updating`);

  await updateProductInWooCommerce(wooProductId, product, wooConfig, variantIdsFilter);
}

async function createProductInWooCommerce(
  product: any,
  wooConfig: WooCommerceConfig,
  variantIdsFilter?: string[]
) {
  const { sku, title, product_prices, variants, images, color, brands, tax_code } = product;

  // Prepare product images - skip images that don't have full URLs
  const productImages = (images || [])
    .filter((img: string) => img && img.trim().length > 0)
    .map((img: string) => {
      // Only include images if they're full URLs, otherwise skip them
      if (img.startsWith('http://') || img.startsWith('https://')) {
        return { src: img };
      }
      return null;
    })
    .filter((img: any) => img !== null);

  // Prepare size attribute values from variants
  const variantsToCreate = variantIdsFilter 
    ? variants?.filter((v: any) => variantIdsFilter.includes(v.id))
    : variants;

  const sizeOptions = variantsToCreate?.map((v: any) => v.size_label) || [];

  // Prepare product data
  const productData: any = {
    name: title,
    type: 'variable', // Variable product since we have variants
    sku: sku,
    status: 'publish',
    catalog_visibility: 'visible',
    images: productImages,
    attributes: [
      {
        name: 'Size',
        position: 0,
        visible: true,
        variation: true,
        options: sizeOptions
      }
    ],
    tax_class: tax_code || '',
  };

  // Add color attribute if available
  if (color?.label) {
    productData.attributes.push({
      name: 'Color',
      position: 1,
      visible: true,
      variation: false,
      options: [color.label]
    });
  }

  // Add brand as category if available
  if (brands?.name) {
    productData.categories = [{ name: brands.name }];
  }

  console.log(`Creating product in WooCommerce: ${sku}`);

  const createUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
  createUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  createUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const createResponse = await fetchWithRetry(createUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(productData),
  });

  if (!createResponse.ok) {
    let errorData;
    try {
      errorData = await createResponse.json();
    } catch {
      const errorText = await createResponse.text();
      throw new Error(`Failed to create product ${sku}: ${createResponse.status} - ${errorText}`);
    }
    
    // If product already exists or image error, try to find and update it instead
    if ((errorData.code === 'woocommerce_rest_product_not_created' && errorData.message?.includes('SKU')) ||
        errorData.code === 'woocommerce_product_image_upload_error') {
      
      const reason = errorData.code === 'woocommerce_product_image_upload_error' ? 'has image errors' : 'already exists';
      console.log(`Product ${sku} ${reason}, searching for it to update`);
      
      // Search again but this time search in all products (not just published)
      const searchAllUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
      searchAllUrl.searchParams.append('sku', sku);
      searchAllUrl.searchParams.append('status', 'any');
      searchAllUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
      searchAllUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
      
      const searchAllResponse = await fetchWithRetry(searchAllUrl.toString(), {
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (searchAllResponse.ok) {
        const foundProducts = await searchAllResponse.json();
        if (foundProducts && foundProducts.length > 0) {
          const existingProduct = foundProducts[0];
          console.log(`Found existing product ${sku} with ID ${existingProduct.id}, updating instead`);
          await updateProductInWooCommerce(existingProduct.id, product, wooConfig, variantIdsFilter);
          return;
        }
      }
    }
    
    const errorText = JSON.stringify(errorData);
    throw new Error(`Failed to create product ${sku}: ${createResponse.status} - ${errorText}`);
  }

  const createdProduct = await createResponse.json();
  console.log(`Created product ${sku} with ID ${createdProduct.id}`);

  // Create variations
  if (variantsToCreate && variantsToCreate.length > 0) {
    await createVariationsInWooCommerce(createdProduct.id, variantsToCreate, product_prices, wooConfig);
  }
}

async function createVariationsInWooCommerce(
  wooProductId: number,
  variants: any[],
  product_prices: any,
  wooConfig: WooCommerceConfig
) {
  console.log(`Creating ${variants.length} variations for product ${wooProductId}`);

  for (const variant of variants) {
    const variationData: any = {
      attributes: [
        {
          name: 'Size',
          option: variant.size_label
        }
      ],
      sku: variant.ean || '',
      manage_stock: true,
      stock_quantity: variant.stock_totals?.qty || 0,
      stock_status: (variant.stock_totals?.qty || 0) > 0 ? 'instock' : 'outofstock',
    };

    // Set prices on the variation
    if (product_prices?.regular) {
      variationData.regular_price = product_prices.regular.toString();
    }
    if (product_prices?.list) {
      variationData.sale_price = product_prices.list.toString();
    }

    // Add EAN to meta_data
    if (variant.ean) {
      variationData.meta_data = [
        { key: 'ean', value: variant.ean }
      ];
    }

    const createVariationUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
    createVariationUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    createVariationUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

    const createResponse = await fetchWithRetry(createVariationUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(variationData),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error(`Failed to create variation ${variant.size_label}: ${errorText}`);
      continue;
    }

    console.log(`Created variation ${variant.size_label} for product ${wooProductId}`);
  }
}

async function updateProductInWooCommerce(
  wooProductId: number,
  product: any,
  wooConfig: WooCommerceConfig,
  variantIdsFilter?: string[]
) {
  const { sku, product_prices, variants, images } = product;

  // First, fetch the existing product to get current images
  const getProductUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
  getProductUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  getProductUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const getResponse = await fetchWithRetry(getProductUrl.toString(), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  let existingImages: any[] = [];
  if (getResponse.ok) {
    const existingProduct = await getResponse.json();
    existingImages = existingProduct.images || [];
  }

  // Prepare new product images from our database
  const newProductImages = (images || [])
    .filter((img: string) => img && img.trim().length > 0)
    .map((img: string) => {
      if (img.startsWith('http://') || img.startsWith('https://')) {
        return { src: img };
      }
      return null;
    })
    .filter((img: any) => img !== null);

  // Check which images are actually new (not already in WooCommerce)
  const existingImageSrcs = new Set(existingImages.map((img: any) => img.src));
  const imagesToAdd = newProductImages.filter((img: any) => !existingImageSrcs.has(img.src));

  // Only update if there are new images to add
  if (imagesToAdd.length > 0) {
    // Merge existing images with new ones to prevent duplicates
    const mergedImages = [...existingImages, ...imagesToAdd];
    
    console.log(`Adding ${imagesToAdd.length} new images to product ${sku} (total: ${mergedImages.length})`);
    
    const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
    updateUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    updateUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

    const updateResponse = await fetchWithRetry(updateUrl.toString(), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ images: mergedImages }),
    });

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error(`Failed to update product images: ${errorText}`);
    }
  } else {
    console.log(`Product ${sku} images are up to date, skipping image update`);
  }

  console.log(`Updating product ${sku}, will set prices on variations`);

  // Update variants (WooCommerce variations) including their prices
  if (variants && variants.length > 0) {
    const variantsToSync = variantIdsFilter 
      ? variants.filter((v: any) => variantIdsFilter.includes(v.id))
      : variants;

    for (const variant of variantsToSync) {
      await syncVariantToWooCommerce(
        wooProductId,
        variant,
        product_prices,
        wooConfig
      );
    }
  }
}

async function syncVariantToWooCommerce(
  wooProductId: number,
  variant: any,
  product_prices: any,
  wooConfig: WooCommerceConfig
) {
  // Find WooCommerce variation by size attribute
  const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
  variationsUrl.searchParams.append('per_page', '100');
  variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
  
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

  // Set prices on the variation
  if (product_prices?.regular) {
    updateData.regular_price = product_prices.regular.toString();
  }
  if (product_prices?.list) {
    updateData.sale_price = product_prices.list.toString();
  }

  // Add EAN to meta_data
  if (variant.ean) {
    updateData.meta_data = [
      { key: 'ean', value: variant.ean }
    ];
  }

  const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/${matchingVariation.id}`);
  updateUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  updateUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
  
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
