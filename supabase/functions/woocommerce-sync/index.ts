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

// Helper function to ensure brand exists in WooCommerce (Perfect WooCommerce Brands plugin)
async function ensureBrandExists(brandName: string, wooConfig: WooCommerceConfig): Promise<number | null> {
  try {
    // Search for existing brand in pwb-brand taxonomy
    const searchUrl = new URL(`${wooConfig.url}/wp-json/wp/v2/pwb-brand`);
    searchUrl.searchParams.append("search", brandName);
    
    // Add WooCommerce auth
    const auth = btoa(`${wooConfig.consumerKey}:${wooConfig.consumerSecret}`);
    
    const searchResponse = await fetchWithRetry(searchUrl.toString(), {
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Basic ${auth}`
      },
    });
    
    if (searchResponse.ok) {
      const existingBrands = await searchResponse.json();
      if (existingBrands.length > 0) {
        const exactMatch = existingBrands.find((brand: any) => 
          brand.name?.toLowerCase() === brandName.toLowerCase()
        );
        if (exactMatch) {
          console.log(`Brand "${brandName}" already exists with ID ${exactMatch.id}`);
          return exactMatch.id;
        }
      }
    }

    // Create new brand
    const createUrl = new URL(`${wooConfig.url}/wp-json/wp/v2/pwb-brand`);
    
    const createResponse = await fetchWithRetry(createUrl.toString(), {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Basic ${auth}`
      },
      body: JSON.stringify({ 
        name: brandName,
        slug: brandName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      }),
    });

    if (createResponse.ok) {
      const newBrand = await createResponse.json();
      console.log(`Created brand "${brandName}" with ID ${newBrand.id}`);
      return newBrand.id;
    } else {
      const errorText = await createResponse.text();
      console.error(`Failed to create brand "${brandName}": ${errorText}`);
      return null;
    }
  } catch (error) {
    console.error(`Error ensuring brand "${brandName}" exists:`, error);
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
        .in('type', ['SYNC_TO_WOO', 'CREATE_NEW_PRODUCTS', 'UPDATE_PRODUCTS'])
        .eq('state', 'processing')
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

    console.log(`Processing ${jobs.length} sync jobs in background`);

    // Start background processing without awaiting
    // This allows us to return a response immediately
    Promise.allSettled(
      jobs.map((job) => processJob(job, supabase, isSchedulerInvoked))
    ).then(results => {
      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      const failureCount = results.filter((r) => r.status === 'rejected').length;
      console.log(`Background sync complete: ${successCount} succeeded, ${failureCount} failed`);
    }).catch(err => {
      console.error('Background sync error:', err);
    });

    // Return immediate response so job-scheduler doesn't timeout
    return new Response(
      JSON.stringify({
        success: true,
        message: `Started processing ${jobs.length} sync jobs in background`,
        jobIds: jobs.map((j: any) => j.id),
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

    // CRITICAL: Very small batches to prevent overwhelming hosting provider
    // SiteGround has blocked us for making too many requests (19/sec)
    const BATCH_SIZE = 5;
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

    // CRITICAL: Only process products if specific IDs are provided
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
    } else {
      // No specific products or variants to sync - job is invalid
      console.log('No productIds or variantIds in job payload - marking as done');
      await supabase.from('jobs').update({ state: 'done', error: 'No products specified' }).eq('id', job.id);
      return;
    }

    const { data: products, error: productsError } = await query;

    if (productsError) throw productsError;
    if (!products || products.length === 0) {
      console.log('No products found for sync');
      await supabase.from('jobs').update({ state: 'done' }).eq('id', job.id);
      return;
    }

    console.log(`Syncing ${products.length} products to WooCommerce`);

    // CRITICAL: Process very slowly to avoid overwhelming hosting provider
    // SiteGround blocked us for 19 req/sec - now we do max ~0.5 req/sec
    for (const product of products) {
      await syncProductToWooCommerce(product, wooConfig, variantIds, supabase, job.tenant_id);
      
      // Add substantial delay between products (3 seconds)
      if (products.indexOf(product) < products.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
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

  // Read response as text first to avoid "Body already consumed" error
  const responseText = await searchResponse.text();
  
  let wooProducts;
  try {
    wooProducts = JSON.parse(responseText);
  } catch (parseError) {
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

  // Ensure size options is a proper array of individual strings
  const sizeOptions: string[] = [];
  if (variantsToCreate && Array.isArray(variantsToCreate)) {
    for (const v of variantsToCreate) {
      if (v.size_label && typeof v.size_label === 'string') {
        sizeOptions.push(v.size_label.trim());
      }
    }
  }
  
  console.log(`Product ${sku} size options (${sizeOptions.length}):`, JSON.stringify(sizeOptions));

  // Fetch ALL global attributes from WooCommerce for new product creation
  let globalAttributes: any[] = [];
  const globalAttributeMap = new Map<string, { id: number; slug: string }>();
  
  try {
    const attrListUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes`);
    attrListUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    attrListUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
    attrListUrl.searchParams.append('per_page', '100');
    
    const attrListResponse = await fetchWithRetry(attrListUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (attrListResponse.ok) {
      globalAttributes = await attrListResponse.json();
      
      for (const attr of globalAttributes) {
        const normalizedName = attr.name?.toLowerCase().trim();
        if (normalizedName) {
          globalAttributeMap.set(normalizedName, { id: attr.id, slug: attr.slug });
        }
        if (attr.slug) {
          globalAttributeMap.set(attr.slug.toLowerCase().replace('pa_', ''), { id: attr.id, slug: attr.slug });
        }
      }
      console.log(`Fetched ${globalAttributes.length} global attributes for new product`);
    }
  } catch (err) {
    console.error('Error fetching global attributes:', err);
  }
  
  const findGlobalAttribute = (name: string): { id: number; slug: string } | null => {
    const normalizedName = name.toLowerCase().trim();
    return globalAttributeMap.get(normalizedName) || null;
  };
  
  const ensureAttributeTerm = async (attrId: number, termValue: string): Promise<void> => {
    try {
      const termsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes/${attrId}/terms`);
      termsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
      termsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
      termsUrl.searchParams.append('per_page', '100');
      termsUrl.searchParams.append('search', termValue);
      
      const termsResponse = await fetchWithRetry(termsUrl.toString(), {
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (termsResponse.ok) {
        const terms = await termsResponse.json();
        const exists = terms.some((t: any) => t.name?.toLowerCase().trim() === termValue.toLowerCase().trim());
        
        if (!exists) {
          const createTermUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes/${attrId}/terms`);
          createTermUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
          createTermUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
          
          await fetchWithRetry(createTermUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: termValue }),
          });
          console.log(`Created attribute term: ${termValue} for attribute ${attrId}`);
        }
      }
    } catch (err) {
      console.error(`Error ensuring attribute term ${termValue}:`, err);
    }
  };
  
  // Get Maat global attribute ID
  const globalMaat = findGlobalAttribute('maat');
  const globalMaatId = globalMaat?.id || 0;
  
  // Ensure size terms exist
  if (globalMaatId > 0) {
    for (const sizeOption of sizeOptions) {
      await ensureAttributeTerm(globalMaatId, sizeOption);
    }
  }
  
  // Build product attributes array using global IDs
  const productAttributes: any[] = [{
    id: globalMaatId,
    name: 'Maat',
    position: 0,
    visible: true,
    variation: true,
    options: sizeOptions
  }];

  // Add color attribute if available
  if (color?.label) {
    const globalColor = findGlobalAttribute('kleur') || findGlobalAttribute('color');
    if (globalColor?.id) {
      await ensureAttributeTerm(globalColor.id, color.label);
    }
    productAttributes.push({
      id: globalColor?.id || 0,
      name: 'Kleur',
      position: 1,
      visible: true,
      variation: false,
      options: [color.label]
    });
  }

  // Add brand as global attribute (pa_merk) for filtering
  if (brands?.name) {
    const globalBrand = findGlobalAttribute('merk') || findGlobalAttribute('brand');
    if (globalBrand?.id) {
      await ensureAttributeTerm(globalBrand.id, brands.name);
      console.log(`Using global brand attribute (ID: ${globalBrand.id}) with value: ${brands.name}`);
    }
    productAttributes.push({
      id: globalBrand?.id || 0,
      name: 'Merk',
      position: productAttributes.length,
      visible: true,
      variation: false,
      options: [brands.name]
    });
  }

  // Map attribute codes to readable values
  const mappedAttributes = tenantId && attributes 
    ? await mapAttributeCodes(attributes, tenantId, supabase)
    : attributes;

  // Add all product attributes using global attribute IDs
  if (mappedAttributes && typeof mappedAttributes === 'object') {
    let position = productAttributes.length;
    for (const [key, value] of Object.entries(mappedAttributes)) {
      const valueStr = String(value).trim();
      if (!valueStr || key.toLowerCase() === 'maat') continue;
      
      const globalAttr = findGlobalAttribute(key);
      
      if (globalAttr?.id) {
        await ensureAttributeTerm(globalAttr.id, valueStr);
        console.log(`Using global attribute "${key}" (ID: ${globalAttr.id}) for new product`);
      }
      
      productAttributes.push({
        id: globalAttr?.id || 0,
        name: key,
        position: position++,
        visible: true,
        variation: false,
        options: [valueStr]
      });
    }
  }
  
  const globalAttrCount = productAttributes.filter((a: any) => a.id > 0).length;
  console.log(`New product ${sku}: ${productAttributes.length} attributes (${globalAttrCount} global)`);

  // Prepare product data
  const productData: any = {
    name: title,
    type: 'variable',
    sku: sku,
    status: 'publish',
    catalog_visibility: 'visible',
    description: webshop_text || '',
    short_description: meta_description || '',
    images: productImages,
    attributes: productAttributes,
    tax_class: tax_code || '',
  };

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
  }

  // Add brand using Perfect WooCommerce Brands taxonomy (separate from categories)
  if (brands?.name) {
    console.log(`Ensuring brand exists: ${brands.name}`);
    const brandId = await ensureBrandExists(brands.name, wooConfig);
    if (brandId) {
      productData.brand_ids = [brandId];
      console.log(`Added brand "${brands.name}" (ID: ${brandId}) to product`);
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
    // Read response as text first to avoid "Body already consumed" error
    const errorText = await createResponse.text();
    
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
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
    
    const errorMessage = JSON.stringify(errorData);
    throw new Error(`Failed to create product ${sku}: ${createResponse.status} - ${errorMessage}`);
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
    await createVariationsInWooCommerce(createdProduct.id, variantsToCreate, product_prices, wooConfig, sku);
  }
}

async function createVariationsInWooCommerce(
  wooProductId: number,
  variants: any[],
  product_prices: any,
  wooConfig: WooCommerceConfig,
  parentSku: string
) {
  console.log(`Creating ${variants.length} variations for product ${wooProductId} with parent SKU ${parentSku}`);
  
  for (const variant of variants) {
    // Build variation SKU in format: productSku-maat_id (e.g., "101069102000-071041")
    // maat_id contains the 6-digit Modis maat code
    const variationSku = parentSku && variant.maat_id ? `${parentSku}-${variant.maat_id}` : (variant.ean || '');
    
    const variationData: any = {
      attributes: [
        {
          name: 'Maat',
          option: variant.size_label
        }
      ],
      sku: variationSku,
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

// Create a single missing variation in WooCommerce
async function createMissingVariation(
  wooProductId: number,
  variant: any,
  product_prices: any,
  wooConfig: WooCommerceConfig,
  parentSku?: string,
  supabase?: any,
  tenantId?: string,
  productTitle?: string
): Promise<any | null> {
  // Build variation SKU in format: productSku-maat_id (e.g., "101069102000-071041")
  const variationSku = parentSku && variant.maat_id ? `${parentSku}-${variant.maat_id}` : (variant.ean || '');
  
  const variationData: any = {
    attributes: [
      {
        name: 'Maat',
        option: variant.size_label
      }
    ],
    sku: variationSku,
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

  try {
    const createResponse = await fetchWithRetry(createVariationUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(variationData),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error(`Failed to create missing variation ${variant.size_label}: ${errorText}`);
      return null;
    }

    const createdVariation = await createResponse.json();
    
    // Log to changelog
    if (supabase && tenantId) {
      await logChangeToChangelog(
        supabase,
        tenantId,
        'WOO_VARIANT_CREATED',
        `Ontbrekende variatie aangemaakt in WooCommerce: ${productTitle || parentSku} - Maat ${variant.size_label}`,
        {
          wooProductId: wooProductId,
          wooVariationId: createdVariation.id,
          sku: variationSku,
          size_label: variant.size_label,
          stock_quantity: variant.stock_totals?.qty || 0
        }
      );
    }
    
    return createdVariation;
  } catch (error) {
    console.error(`Error creating missing variation ${variant.size_label}:`, error);
    return null;
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
  }

  // Update brand using Perfect WooCommerce Brands taxonomy (separate from categories)
  if (brands?.name) {
    console.log(`Ensuring brand exists for update: ${brands.name}`);
    const brandId = await ensureBrandExists(brands.name, wooConfig);
    if (brandId) {
      updateData.brand_ids = [brandId];
      console.log(`Updated brand "${brands.name}" (ID: ${brandId}) on product`);
    }
  }

  // Update attributes - Use GLOBAL "Maat" attribute for proper WooCommerce filtering
  // Global attributes have terms that work with layered navigation and filters
  
  // Build size options as proper array of individual strings
  const updateSizeOptions: string[] = [];
  if (variants && Array.isArray(variants)) {
    for (const v of variants) {
      if (v.size_label && typeof v.size_label === 'string') {
        updateSizeOptions.push(v.size_label.trim());
      }
    }
  }
  
  console.log(`Product ${sku} update size options (${updateSizeOptions.length}):`, JSON.stringify(updateSizeOptions));
  
  // Fetch existing product attributes from WooCommerce
  const fetchAttrUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
  fetchAttrUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  fetchAttrUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
  
  const fetchAttrResponse = await fetchWithRetry(fetchAttrUrl.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  let existingAttributes: any[] = [];
  if (fetchAttrResponse.ok) {
    const existingProduct = await fetchAttrResponse.json();
    existingAttributes = existingProduct.attributes || [];
    console.log(`Fetched ${existingAttributes.length} existing attributes from WooCommerce`);
  }
  
  // Fetch ALL global attributes from WooCommerce
  let globalAttributes: any[] = [];
  const globalAttributeMap = new Map<string, { id: number; slug: string }>();
  
  try {
    const attrListUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes`);
    attrListUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    attrListUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
    attrListUrl.searchParams.append('per_page', '100');
    
    const attrListResponse = await fetchWithRetry(attrListUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (attrListResponse.ok) {
      globalAttributes = await attrListResponse.json();
      
      // Build a map of all global attributes (name -> id, slug)
      for (const attr of globalAttributes) {
        const normalizedName = attr.name?.toLowerCase().trim();
        if (normalizedName) {
          globalAttributeMap.set(normalizedName, { id: attr.id, slug: attr.slug });
        }
        // Also map by slug for fallback matching
        if (attr.slug) {
          globalAttributeMap.set(attr.slug.toLowerCase().replace('pa_', ''), { id: attr.id, slug: attr.slug });
        }
      }
      
      console.log(`Fetched ${globalAttributes.length} global attributes from WooCommerce`);
    }
  } catch (err) {
    console.error('Error fetching global attributes:', err);
  }
  
  // Helper function to find or create a global attribute
  const findGlobalAttribute = (name: string): { id: number; slug: string } | null => {
    const normalizedName = name.toLowerCase().trim();
    return globalAttributeMap.get(normalizedName) || null;
  };
  
  // Helper function to ensure attribute term exists
  const ensureAttributeTerm = async (attrId: number, termValue: string): Promise<void> => {
    try {
      // Check if term exists
      const termsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes/${attrId}/terms`);
      termsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
      termsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
      termsUrl.searchParams.append('per_page', '100');
      termsUrl.searchParams.append('search', termValue);
      
      const termsResponse = await fetchWithRetry(termsUrl.toString(), {
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (termsResponse.ok) {
        const terms = await termsResponse.json();
        const exists = terms.some((t: any) => t.name?.toLowerCase().trim() === termValue.toLowerCase().trim());
        
        if (!exists) {
          // Create the term
          const createTermUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes/${attrId}/terms`);
          createTermUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
          createTermUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
          
          await fetchWithRetry(createTermUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: termValue }),
          });
          console.log(`Created attribute term: ${termValue} for attribute ${attrId}`);
        }
      }
    } catch (err) {
      console.error(`Error ensuring attribute term ${termValue}:`, err);
    }
  };
  
  // Get Maat global attribute ID and ensure size terms exist
  const globalMaat = findGlobalAttribute('maat');
  const globalMaatId = globalMaat?.id || 0;
  
  if (globalMaatId > 0) {
    console.log(`Found global Maat attribute with ID: ${globalMaatId}`);
    // Ensure all size options exist as terms
    for (const sizeOption of updateSizeOptions) {
      await ensureAttributeTerm(globalMaatId, sizeOption);
    }
  }
  
  // Find existing Maat attribute index on this product
  const maatIndex = existingAttributes.findIndex((attr: any) => 
    attr.name?.toLowerCase() === 'maat' || 
    attr.name?.toLowerCase() === 'size' ||
    attr.slug?.toLowerCase() === 'maat' ||
    attr.slug?.toLowerCase() === 'pa_maat'
  );
  
  // Create the Maat attribute - use global ID if available
  const maatAttribute = {
    id: globalMaatId > 0 ? globalMaatId : (maatIndex >= 0 ? existingAttributes[maatIndex].id : 0),
    name: 'Maat',
    position: 0,
    visible: true,
    variation: true,
    options: updateSizeOptions
  };
  
  // Build the updated attributes array
  let updatedAttributes: any[] = [];
  
  // Add Maat first
  if (maatIndex >= 0) {
    updatedAttributes = [...existingAttributes];
    updatedAttributes[maatIndex] = maatAttribute;
  } else {
    updatedAttributes = [maatAttribute, ...existingAttributes];
  }
  
  // Now process ALL other attributes from the database and ensure they use global IDs
  const mappedAttributes = tenantId && attributes 
    ? await mapAttributeCodes(attributes, tenantId, supabase)
    : attributes;
  
  if (mappedAttributes && typeof mappedAttributes === 'object') {
    for (const [attrName, attrValue] of Object.entries(mappedAttributes)) {
      const valueStr = String(attrValue).trim();
      if (!valueStr) continue;
      
      // Skip if it's Maat (already handled)
      if (attrName.toLowerCase() === 'maat') continue;
      
      // Try to find a global attribute for this name
      const globalAttr = findGlobalAttribute(attrName);
      
      // Check if this attribute already exists in the product
      const existingIndex = updatedAttributes.findIndex((a: any) => 
        a.name?.toLowerCase() === attrName.toLowerCase() ||
        a.slug?.toLowerCase() === attrName.toLowerCase().replace(/\s+/g, '-')
      );
      
      const newAttr = {
        id: globalAttr?.id || 0,
        name: attrName,
        position: existingIndex >= 0 ? updatedAttributes[existingIndex].position : updatedAttributes.length,
        visible: true,
        variation: false,
        options: [valueStr]
      };
      
      // Ensure the term exists if we have a global attribute
      if (globalAttr?.id) {
        await ensureAttributeTerm(globalAttr.id, valueStr);
        console.log(`Using global attribute "${attrName}" (ID: ${globalAttr.id}) with value: ${valueStr}`);
      }
      
      if (existingIndex >= 0) {
        updatedAttributes[existingIndex] = newAttr;
      } else {
        updatedAttributes.push(newAttr);
      }
    }
  }
  
  // Add brand as global attribute (pa_merk) for filtering
  if (brands?.name) {
    const globalBrand = findGlobalAttribute('merk') || findGlobalAttribute('brand');
    
    // Check if Merk attribute already exists
    const merkIndex = updatedAttributes.findIndex((a: any) => 
      a.name?.toLowerCase() === 'merk' ||
      a.slug?.toLowerCase() === 'merk' ||
      a.slug?.toLowerCase() === 'pa_merk'
    );
    
    const merkAttr = {
      id: globalBrand?.id || 0,
      name: 'Merk',
      position: merkIndex >= 0 ? updatedAttributes[merkIndex].position : updatedAttributes.length,
      visible: true,
      variation: false,
      options: [brands.name]
    };
    
    if (globalBrand?.id) {
      await ensureAttributeTerm(globalBrand.id, brands.name);
      console.log(`Using global brand attribute (ID: ${globalBrand.id}) with value: ${brands.name}`);
    }
    
    if (merkIndex >= 0) {
      updatedAttributes[merkIndex] = merkAttr;
    } else {
      updatedAttributes.push(merkAttr);
    }
  }
  
  // Re-assign positions to ensure proper ordering (Maat first)
  updatedAttributes = updatedAttributes.map((attr, idx) => ({
    ...attr,
    position: idx
  }));

  updateData.attributes = updatedAttributes;
  
  const globalAttrCount = updatedAttributes.filter((a: any) => a.id > 0).length;
  console.log(`Sending ${updatedAttributes.length} attributes (${globalAttrCount} global), Maat variation=${maatAttribute.variation}, options count=${updateSizeOptions.length}`);

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
  
  // Helper function to normalize size strings for comparison
  const normalizeSize = (size: string): string => {
    return size?.toLowerCase().trim().replace(/\s+/g, ' ') || '';
  };
  
  // Helper to extract size parts from format like "45 = 10½" or "42/8"
  const extractSizeParts = (sizeLabel: string): string[] => {
    const parts: string[] = [normalizeSize(sizeLabel)];
    
    // Split by " = ", "=", "/", or " / " and add all parts
    if (sizeLabel?.includes('=') || sizeLabel?.includes('/')) {
      const splitParts = sizeLabel.split(/\s*[=\/]\s*/);
      parts.push(...splitParts.map(normalizeSize).filter(p => p));
    }
    
    // Extract any numbers (e.g., "45" from "45 = 10½")
    const numbers = sizeLabel?.match(/\d+\.?\d*/g);
    if (numbers) {
      parts.push(...numbers.map(normalizeSize));
    }
    
    return [...new Set(parts)]; // Remove duplicates
  };
  
  const dbSizeParts = extractSizeParts(variant.size_label);
  
  // Build expected SKU suffix for SKU-based matching
  // NEW Format: productSku-maat_id (e.g., "101069102000-071041")
  // maat_id contains the 6-digit Modis maat code
  const expectedFullSku = productSku && variant.maat_id ? `${productSku}-${variant.maat_id}` : null;
  // Also keep old format for backwards compatibility during migration
  const legacyFullSku = productSku ? `${productSku}-${variant.size_label}` : null;
  
  // Debug: Log WooCommerce variations to understand structure
  console.log(`Found ${wooVariations.length} WooCommerce variations for product ${wooProductId}`);
  if (wooVariations.length > 0) {
    const sampleAttrs = wooVariations.slice(0, 3).map((v: any) => ({
      id: v.id,
      sku: v.sku,
      attributes: v.attributes?.map((a: any) => `${a.name}=${a.option}`).join(', ') || 'none'
    }));
    console.log(`Sample WooCommerce variation attributes: ${JSON.stringify(sampleAttrs)}`);
  }
  
  // Find matching variation by size attribute or SKU with multiple fallback strategies
  let matchingVariation = null;
  
  for (const wooVariation of wooVariations) {
    // Strategy 0: Match by variation SKU (most reliable when SKU contains maat_id)
    // NEW WooCommerce SKU format: "101069102000-071041" (productSku-maat_id)
    if (wooVariation.sku && expectedFullSku) {
      // Exact SKU match with new format (case-insensitive, whitespace-normalized)
      if (normalizeSize(wooVariation.sku) === normalizeSize(expectedFullSku)) {
        matchingVariation = wooVariation;
        console.log(`Matched variation by exact SKU (new format): ${wooVariation.sku}`);
        break;
      }
    }
    
    // Strategy 0b: Legacy format match (productSku-size_label)
    // For backwards compatibility during migration
    if (wooVariation.sku && legacyFullSku) {
      if (normalizeSize(wooVariation.sku) === normalizeSize(legacyFullSku)) {
        matchingVariation = wooVariation;
        console.log(`Matched variation by legacy SKU format: ${wooVariation.sku}`);
        break;
      }
      // Check if WooCommerce SKU ends with the exact size_label
      if (wooVariation.sku.endsWith(variant.size_label)) {
        matchingVariation = wooVariation;
        console.log(`Matched variation by SKU suffix: ${wooVariation.sku} ends with ${variant.size_label}`);
        break;
      }
    }
    
    // Strategy 1-3: Match by Size attribute
    const sizeAttr = wooVariation.attributes?.find((attr: any) => 
      attr.name?.toLowerCase() === 'size' || 
      attr.name?.toLowerCase() === 'maat' ||
      attr.name?.toLowerCase() === 'pa_size' ||
      attr.name?.toLowerCase() === 'pa_maat'
    );
    
    if (sizeAttr?.option) {
      const wooSizeNormalized = normalizeSize(sizeAttr.option);
      
      // Strategy 1: Exact match (normalized) with full size_label
      if (normalizeSize(variant.size_label) === wooSizeNormalized) {
        matchingVariation = wooVariation;
        console.log(`Matched variation by exact Maat attribute: ${sizeAttr.option}`);
        break;
      }
    }
  }

  if (!matchingVariation) {
    console.log(`No matching WooCommerce variation found for size ${variant.size_label}, creating new variation...`);
    
    // Create missing variation in WooCommerce
    const createdVariation = await createMissingVariation(
      wooProductId,
      variant,
      product_prices,
      wooConfig,
      productSku,
      supabase,
      tenantId,
      productTitle
    );
    
    if (createdVariation) {
      console.log(`Created missing variation ${variant.size_label} with ID ${createdVariation.id}`);
    }
    return;
  }

  console.log(`Updating WooCommerce variation ${matchingVariation.id} for size ${variant.size_label}`);

  // Prepare update data
  const updateData: any = {
    stock_quantity: variant.stock_totals?.qty || 0,
    manage_stock: true,
    stock_status: (variant.stock_totals?.qty || 0) > 0 ? 'instock' : 'outofstock',
  };

  // Update variation SKU to new format: {productSku}-{maat_id}
  // Only update if maat_id is a 6-digit code and SKU differs
  if (expectedFullSku && variant.maat_id && variant.maat_id.length === 6) {
    const currentWooSku = matchingVariation.sku || '';
    if (currentWooSku !== expectedFullSku) {
      updateData.sku = expectedFullSku;
      console.log(`Updating variation SKU: "${currentWooSku}" → "${expectedFullSku}"`);
    }
  }

  // ALWAYS set the Maat attribute on variations using the SLUG format
  // WooCommerce requires 'pa_maat' slug for global attributes on variations
  // This ensures proper linking to attribute terms for filtering
  const currentSizeAttr = matchingVariation.attributes?.find((attr: any) => 
    attr.name?.toLowerCase() === 'size' || 
    attr.name?.toLowerCase() === 'maat' ||
    attr.name?.toLowerCase() === 'pa_size' ||
    attr.name?.toLowerCase() === 'pa_maat'
  );
  
  // For variations, we MUST use the attribute slug (pa_maat) not the display name
  // This is how WooCommerce links variations to global attribute terms
  updateData.attributes = [{
    id: currentSizeAttr?.id || 0,
    name: 'pa_maat', // Use slug format for proper global attribute linking
    option: variant.size_label
  }];
  
  if (currentSizeAttr?.option !== variant.size_label) {
    console.log(`Setting Maat attribute to "${variant.size_label}" (was: "${currentSizeAttr?.option || 'none'}")`);
  }

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
  
  // Log to changelog - track stock, price, and size attribute changes
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
    
    // Check if size attribute was updated
    if (updateData.attributes?.length > 0) {
      const currentSizeAttr = matchingVariation.attributes?.find((attr: any) => 
        attr.name?.toLowerCase() === 'size' || 
        attr.name?.toLowerCase() === 'maat' ||
        attr.name?.toLowerCase() === 'pa_size' ||
        attr.name?.toLowerCase() === 'pa_maat'
      );
      if (currentSizeAttr) {
        changesArray.push(`maat attribuut "${currentSizeAttr.option}" → "${variant.size_label}"`);
      }
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

// Create HTTP/1.1 client to prevent HTTP/2 protocol errors
const http11Client = Deno.createHttpClient({ http2: false });

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // CRITICAL: Add delay before ALL requests to prevent overwhelming host
      // SiteGround blocked us for making 19 req/sec
      const initialDelay = attempt === 1 ? 1000 : Math.pow(2, attempt) * 1500;
      await new Promise(resolve => setTimeout(resolve, initialDelay));
      
      const fetchOptions: RequestInit = {
        ...options,
        // @ts-ignore - Deno.createHttpClient is not in RequestInit types
        client: http11Client,
        headers: {
          ...options.headers,
          'Connection': 'close', // Force connection closure to avoid TLS issues
        },
      };

      const response = await fetch(url, fetchOptions);

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
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      
      // Check if it's a retryable network/protocol error
      const isRetryableError = 
        errorMsg.includes('http2 error') ||
        errorMsg.includes('protocol error') ||
        errorMsg.includes('stream error') ||
        errorMsg.includes('ECONNRESET') ||
        errorMsg.includes('ETIMEDOUT') ||
        errorMsg.includes('close_notify') ||
        errorMsg.includes('connection error') ||
        errorMsg.includes('peer closed') ||
        errorMsg.includes('unexpected eof');
      
      if (attempt < maxRetries && isRetryableError) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`TLS error, retry ${attempt}/${maxRetries} in ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      } else if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Request failed, retry ${attempt}/${maxRetries} in ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  throw lastError || new Error('Max retries exceeded');
}
