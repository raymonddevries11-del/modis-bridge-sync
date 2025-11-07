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

// Helper function to map attribute codes to values
async function mapAttributeCodes(
  attributes: Record<string, any>,
  tenantId: string,
  supabase: any
): Promise<Record<string, string>> {
  const mappedAttributes: Record<string, string> = {};
  
  // Get all attribute mappings for this tenant
  const { data: mappings } = await supabase
    .from('attribute_mappings')
    .select('attribute_name, code, value')
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
  
  if (!mappings) return attributes;
  
  // Create a lookup map
  const lookupMap = new Map<string, string>();
  for (const mapping of mappings) {
    const key = `${mapping.attribute_name}|${mapping.code}`;
    lookupMap.set(key, mapping.value);
  }
  
  // Map each attribute
  for (const [attrName, attrCode] of Object.entries(attributes)) {
    const key = `${attrName}|${attrCode}`;
    const mappedValue = lookupMap.get(key);
    
    if (mappedValue) {
      mappedAttributes[attrName] = mappedValue;
    } else {
      // Keep original if no mapping found
      mappedAttributes[attrName] = String(attrCode);
    }
  }
  
  return mappedAttributes;
}

// Helper function to ensure category exists in WooCommerce
async function ensureCategoryExists(categoryName: string, wooConfig: WooCommerceConfig): Promise<number | null> {
  try {
    // Search for existing category
    const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/categories`);
    searchUrl.searchParams.append("consumer_key", wooConfig.consumerKey);
    searchUrl.searchParams.append("consumer_secret", wooConfig.consumerSecret);
    searchUrl.searchParams.append("search", categoryName);

    const searchResponse = await fetch(searchUrl.toString());
    if (searchResponse.ok) {
      const existingCategories = await searchResponse.json();
      if (existingCategories.length > 0) {
        const exactMatch = existingCategories.find((cat: any) => cat.name === categoryName);
        if (exactMatch) {
          console.log(`Category "${categoryName}" already exists with ID ${exactMatch.id}`);
          return exactMatch.id;
        }
      }
    }

    // Create new category
    const createUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/categories`);
    createUrl.searchParams.append("consumer_key", wooConfig.consumerKey);
    createUrl.searchParams.append("consumer_secret", wooConfig.consumerSecret);

    const createResponse = await fetch(createUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: categoryName }),
    });

    if (createResponse.ok) {
      const newCategory = await createResponse.json();
      console.log(`Created category "${categoryName}" with ID ${newCategory.id}`);
      return newCategory.id;
    } else {
      const errorText = await createResponse.text();
      console.error(`Failed to create category "${categoryName}": ${errorText}`);
      return null;
    }
  } catch (error) {
    console.error(`Error ensuring category "${categoryName}" exists:`, error);
    return null;
  }
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
    let isSchedulerInvoked = false;
    const body = await req.json().catch(() => ({}));
    
    if (body.jobId) {
      // Process specific job (called by job-scheduler)
      console.log(`Processing specific job: ${body.jobId}`);
      isSchedulerInvoked = true;
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
      jobs.map((job) => processJob(job, supabase, isSchedulerInvoked))
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

async function logChangeToChangelog(
  supabase: any,
  tenantId: string,
  eventType: string,
  description: string,
  metadata: any
) {
  try {
    await supabase
      .from('changelog')
      .insert({
        tenant_id: tenantId,
        event_type: eventType,
        description,
        metadata
      });
    console.log(`Logged to changelog: ${eventType} - ${description}`);
  } catch (error) {
    console.error('Failed to log to changelog:', error);
  }
}


async function processJob(
  job: any,
  supabase: any,
  isSchedulerInvoked: boolean = false
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

    // Limit batch size to prevent timeouts - smaller batches for reliability
    const BATCH_SIZE = 3;
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

    // Fetch products with their prices, variants, brands, and other needed data (filtered by tenant)
    let query = supabase
      .from('products')
      .select(`
        *,
        brands(id, name),
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
      await syncProductToWooCommerce(product, wooConfig, variantIds, supabase, job.tenant_id);
    }

    // Always mark job as done on success
    await supabase.from('jobs').update({ state: 'done', error: null }).eq('id', job.id);
      
    // Add changelog entry only if NOT invoked by scheduler
    if (!isSchedulerInvoked) {
      await supabase.from('changelog').insert({
        tenant_id: job.tenant_id,
        event_type: 'SYNC_COMPLETED',
        description: `${products.length} producten gesynchroniseerd naar WooCommerce`,
        metadata: {
          productCount: products.length,
          jobId: job.id
        }
      });
    }
    
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
      // Permanent failure - always update to error state
      await supabase
        .from('jobs')
        .update({ 
          state: 'error', 
          error: errorMessage 
        })
        .eq('id', job.id);
      
      // Log failed sync to changelog only if not scheduler invoked
      if (!isSchedulerInvoked) {
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
    }

    throw error;
  }
}

async function syncProductToWooCommerce(
  product: any,
  wooConfig: WooCommerceConfig,
  variantIdsFilter?: string[],
  supabase?: any,
  tenantId?: string
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
    const errorText = await searchResponse.text();
    throw new Error(`Failed to search for product ${sku}: ${searchResponse.status} ${searchResponse.statusText} - ${errorText.substring(0, 200)}`);
  }

  let wooProducts;
  try {
    wooProducts = await searchResponse.json();
  } catch (parseError) {
    const responseText = await searchResponse.text();
    console.error('Failed to parse JSON response:', responseText.substring(0, 500));
    throw new Error(`Invalid JSON response from WooCommerce API. Response starts with: ${responseText.substring(0, 100)}. This often indicates a Cloudflare/CDN block or incorrect WooCommerce URL.`);
  }
  
  // If product doesn't exist, create it
  if (!wooProducts || wooProducts.length === 0) {
    console.log(`Product ${sku} not found in WooCommerce, creating new product`);
    await createProductInWooCommerce(product, wooConfig, variantIdsFilter, supabase, tenantId);
    return;
  }

  // Product exists, update it
  const wooProduct = wooProducts[0];
  const wooProductId = wooProduct.id;
  console.log(`Found WooCommerce product ID ${wooProductId} for SKU ${sku}, updating`);

  await updateProductInWooCommerce(wooProductId, product, wooConfig, variantIdsFilter, supabase, tenantId);
}

async function createProductInWooCommerce(
  product: any,
  wooConfig: WooCommerceConfig,
  variantIdsFilter?: string[],
  supabase?: any,
  tenantId?: string
) {
  const { sku, title, product_prices, variants, images, color, brands, tax_code, webshop_text, meta_description, categories, attributes } = product;

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
    description: webshop_text || '',
    short_description: meta_description || '',
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

  // Map attribute codes to readable values
  const mappedAttributes = tenantId && attributes 
    ? await mapAttributeCodes(attributes, tenantId, supabase)
    : attributes;

  // Add all product attributes from database as custom attributes
  if (mappedAttributes && typeof mappedAttributes === 'object') {
    let position = productData.attributes.length;
    for (const [key, value] of Object.entries(mappedAttributes)) {
      const valueStr = String(value).trim();
      
      if (valueStr) {
        productData.attributes.push({
          name: key,
          position: position++,
          visible: true,
          variation: false,
          options: [valueStr]
        });
      }
    }
  }

  // Add categories if available - ensure they exist first
  console.log(`Product ${sku} has categories:`, categories);
  if (categories && Array.isArray(categories) && categories.length > 0) {
    const categoryIds: number[] = [];
    for (const cat of categories) {
      if (cat.name) {
        console.log(`Ensuring category exists: ${cat.name}`);
        const catId = await ensureCategoryExists(cat.name, wooConfig);
        if (catId) {
          categoryIds.push(catId);
        }
      }
    }
    if (categoryIds.length > 0) {
      productData.categories = categoryIds.map(id => ({ id }));
      console.log(`Added ${categoryIds.length} categories to product`);
    }
  } else if (brands?.name) {
    // Fallback to brand as category if no categories available
    const brandCatId = await ensureCategoryExists(brands.name, wooConfig);
    if (brandCatId) {
      productData.categories = [{ id: brandCatId }];
    }
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
          await updateProductInWooCommerce(existingProduct.id, product, wooConfig, variantIdsFilter, supabase, tenantId);
          return;
        }
      }
    }
    
    const errorText = JSON.stringify(errorData);
    throw new Error(`Failed to create product ${sku}: ${createResponse.status} - ${errorText}`);
  }

  const createdProduct = await createResponse.json();
  console.log(`Created product ${sku} with ID ${createdProduct.id}`);

  // Log to changelog
  if (supabase && tenantId) {
    await logChangeToChangelog(
      supabase,
      tenantId,
      'WOO_PRODUCT_CREATED',
      `Nieuw product aangemaakt in WooCommerce: ${title} (${sku})`,
      {
        productId: product.id,
        sku: sku,
        title: title,
        wooProductId: createdProduct.id,
        variantCount: variantsToCreate?.length || 0
      }
    );
  }

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
  variantIdsFilter?: string[],
  supabase?: any,
  tenantId?: string
) {
  const { sku, title, variants, images, product_prices, webshop_text, meta_description, categories, brands, attributes, color } = product;

  console.log(`Updating product ${sku}, will set prices on variations`);

  // Fetch current WooCommerce product to get existing images
  const getProductUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
  getProductUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  getProductUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const getResponse = await fetchWithRetry(getProductUrl.toString(), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!getResponse.ok) {
    console.error(`Failed to fetch product ${wooProductId} for image comparison`);
    return; // Skip image update if we can't fetch current state
  }

  const existingProduct = await getResponse.json();
  const existingImages = existingProduct.images || [];
  
  // Extract base filenames from existing images (strip WordPress suffixes like -1, -2, -scaled, etc.)
  const existingImageFilenames = new Set(existingImages.map((img: any) => {
    try {
      const url = new URL(img.src);
      const pathname = url.pathname;
      const filename = pathname.split('/').pop() || '';
      
      // Remove extension first
      const filenameWithoutExt = filename.replace(/\.[^/.]+$/, '');
      
      // Remove WordPress auto-generated suffixes: -1, -2, -3, -scaled, etc.
      const baseFilename = filenameWithoutExt.replace(/-\d+$/, '').replace(/-scaled$/, '');
      
      return baseFilename.toLowerCase();
    } catch {
      return '';
    }
  }).filter(Boolean));

  console.log(`Product ${sku} has ${existingImages.length} existing images with base filenames:`, Array.from(existingImageFilenames));

  // Prepare images from our database and filter out ones that already exist
  const newImagesToAdd = (images || [])
    .filter((img: string) => img && img.trim().length > 0)
    .filter((img: string) => {
      // Only process valid URLs
      if (!img.startsWith('http://') && !img.startsWith('https://')) {
        return false;
      }
      
      // Check if base filename already exists in WooCommerce
      try {
        const url = new URL(img);
        const pathname = url.pathname;
        const filename = pathname.split('/').pop() || '';
        
        // Get base filename without extension and suffixes
        const filenameWithoutExt = filename.replace(/\.[^/.]+$/, '');
        const baseFilename = filenameWithoutExt.replace(/-\d+$/, '').replace(/-scaled$/, '');
        
        if (existingImageFilenames.has(baseFilename.toLowerCase())) {
          console.log(`Skipping duplicate image: ${filename} (matches existing base: ${baseFilename})`);
          return false;
        }
        
        return true;
      } catch {
        return false;
      }
    })
    .map((img: string) => ({ src: img }));

  // Only update if there are actually new images to add
  if (newImagesToAdd.length > 0) {
    const mergedImages = [...existingImages, ...newImagesToAdd];
    
    console.log(`Adding ${newImagesToAdd.length} new images to product ${sku} (total: ${mergedImages.length})`);
    
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
    console.log(`Product ${sku} has no new images to add (${existingImages.length} existing)`);
  }

  // Prepare product update data with descriptions and categories
  const updateData: any = {};
  
  if (webshop_text) {
    updateData.description = webshop_text;
  }
  
  if (meta_description) {
    updateData.short_description = meta_description;
  }
  
  // Update categories - ensure they exist first
  console.log(`Product ${sku} has categories:`, categories);
  if (categories && Array.isArray(categories) && categories.length > 0) {
    const categoryIds: number[] = [];
    for (const cat of categories) {
      if (cat.name) {
        console.log(`Ensuring category exists: ${cat.name}`);
        const catId = await ensureCategoryExists(cat.name, wooConfig);
        if (catId) {
          categoryIds.push(catId);
        }
      }
    }
    if (categoryIds.length > 0) {
      updateData.categories = categoryIds.map(id => ({ id }));
      console.log(`Added ${categoryIds.length} categories to product`);
    }
  } else if (brands?.name) {
    // Fallback to brand as category
    console.log(`Using brand "${brands.name}" as category`);
    const brandCatId = await ensureCategoryExists(brands.name, wooConfig);
    if (brandCatId) {
      updateData.categories = [{ id: brandCatId }];
      console.log(`Added brand "${brands.name}" as category`);
    }
  }

  // Update attributes
  const updatedAttributes: any[] = [
    {
      name: 'Size',
      position: 0,
      visible: true,
      variation: true,
      options: variants?.map((v: any) => v.size_label) || []
    }
  ];

  // Add color attribute if available
  if (color?.label) {
    updatedAttributes.push({
      name: 'Color',
      position: 1,
      visible: true,
      variation: false,
      options: [color.label]
    });
  }

  // Map attribute codes to readable values
  const mappedAttributes = tenantId && attributes 
    ? await mapAttributeCodes(attributes, tenantId, supabase)
    : attributes;

  // Add all product attributes from database as custom attributes
  if (mappedAttributes && typeof mappedAttributes === 'object') {
    let position = updatedAttributes.length;
    for (const [key, value] of Object.entries(mappedAttributes)) {
      const valueStr = String(value).trim();
      
      if (valueStr) {
        updatedAttributes.push({
          name: key,
          position: position++,
          visible: true,
          variation: false,
          options: [valueStr]
        });
      }
    }
  }

  updateData.attributes = updatedAttributes;

  // Update product data if there's anything to update
  if (Object.keys(updateData).length > 0) {
    const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
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
      const errorText = await updateResponse.text();
      console.error(`Failed to update product data: ${errorText}`);
    } else {
      console.log(`Updated product ${sku} data (description, categories)`);
      
      // Log to changelog
      if (supabase && tenantId) {
        const changesArray = [];
        if (updateData.description) changesArray.push('beschrijving');
        if (updateData.short_description) changesArray.push('korte beschrijving');
        if (updateData.categories) changesArray.push(`categorieën (${updateData.categories.length})`);
        if (updateData.images) changesArray.push(`afbeeldingen (${updateData.images.length} nieuw)`);
        
        await logChangeToChangelog(
          supabase,
          tenantId,
          'WOO_PRODUCT_UPDATED',
          `Product geüpdatet in WooCommerce: ${title} (${sku}) - ${changesArray.join(', ')}`,
          {
            productId: product.id,
            sku: sku,
            title: title,
            wooProductId: wooProductId,
            changes: changesArray
          }
        );
      }
    }
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
        wooConfig,
        supabase,
        tenantId,
        sku,
        title
      );
    }
  }
}

async function syncVariantToWooCommerce(
  wooProductId: number,
  variant: any,
  product_prices: any,
  wooConfig: WooCommerceConfig,
  supabase?: any,
  tenantId?: string,
  productSku?: string,
  productTitle?: string
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
  
  // Log to changelog - track stock and price changes
  if (supabase && tenantId) {
    const changesArray = [];
    
    // Check if stock changed
    if (matchingVariation.stock_quantity !== updateData.stock_quantity) {
      changesArray.push(`voorraad ${matchingVariation.stock_quantity} → ${updateData.stock_quantity}`);
    }
    
    // Check if prices changed
    if (updateData.regular_price && matchingVariation.regular_price !== updateData.regular_price) {
      changesArray.push(`normale prijs ${matchingVariation.regular_price} → ${updateData.regular_price}`);
    }
    if (updateData.sale_price && matchingVariation.sale_price !== updateData.sale_price) {
      changesArray.push(`aanbiedingsprijs ${matchingVariation.sale_price} → ${updateData.sale_price}`);
    }
    
    if (changesArray.length > 0) {
      await logChangeToChangelog(
        supabase,
        tenantId,
        'WOO_VARIANT_UPDATED',
        `Variant geüpdatet in WooCommerce: ${productTitle || 'Product'} (${productSku || 'N/A'}) - Maat ${variant.size_label}: ${changesArray.join(', ')}`,
        {
          variantId: variant.id,
          productSku: productSku,
          size: variant.size_label,
          wooProductId: wooProductId,
          wooVariationId: matchingVariation.id,
          changes: changesArray,
          oldStock: matchingVariation.stock_quantity,
          newStock: updateData.stock_quantity,
          oldPrice: matchingVariation.regular_price,
          newPrice: updateData.regular_price
        }
      );
    }
  }
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
