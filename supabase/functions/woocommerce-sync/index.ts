import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Upsert into woo_products to keep local SKU cache in sync and prevent duplicate CREATE jobs */
async function upsertWooProductCache(
  supabase: any,
  tenantId: string,
  wooId: number,
  productId: string,
  sku: string,
  name: string,
  slug?: string,
  status?: string,
  type?: string,
) {
  try {
    await supabase.from('woo_products').upsert({
      tenant_id: tenantId,
      woo_id: wooId,
      product_id: productId,
      sku,
      name,
      slug: slug || '',
      status: status || 'publish',
      type: type || 'variable',
      last_pushed_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,woo_id' });
  } catch (e) {
    console.error(`Failed to upsert woo_products cache for ${sku}:`, e);
  }
}

// --- Base64 image conversion for Supabase storage URLs ---
// SiteGround's firewall blocks WooCommerce from fetching Supabase storage URLs.
// We download images server-side and convert to data URLs.

const MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', JPG: 'image/jpeg',
  JPEG: 'image/jpeg', PNG: 'image/png',
};

function isSupabaseStorageUrl(url: string): boolean {
  return url.includes('supabase.co/storage');
}

function extractStoragePath(url: string): string | null {
  const match = url.match(/\/storage\/v1\/object\/public\/product-images\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function convertToDataUrl(imageUrl: string, supabase: any): Promise<string | null> {
  const storagePath = extractStoragePath(imageUrl);
  if (!storagePath) return imageUrl;

  try {
    const { data: fileData, error } = await supabase.storage
      .from('product-images')
      .download(storagePath);

    if (error || !fileData) {
      console.warn(`⚠ Image not found in storage, skipping: ${storagePath} (${error?.message})`);
      return null;
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length > 5 * 1024 * 1024) {
      console.warn(`Image too large for base64 (${(bytes.length / 1024 / 1024).toFixed(1)}MB): ${storagePath}`);
      return null;
    }

    if (bytes.length < 100) {
      console.warn(`⚠ Image file too small / empty, skipping: ${storagePath} (${bytes.length} bytes)`);
      return null;
    }

    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const ext = storagePath.split('.').pop() || 'jpg';
    const mimeType = MIME_TYPES[ext] || 'image/jpeg';

    console.log(`✓ Converted ${storagePath} to data URL (${(bytes.length / 1024).toFixed(0)}KB)`);
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    console.warn(`Base64 conversion failed for ${storagePath}:`, err);
    return null;
  }
}

async function convertImagesToDataUrls(imageUrls: string[], supabase: any): Promise<string[]> {
  const results: string[] = [];
  const failed: string[] = [];
  for (const url of imageUrls) {
    if (isSupabaseStorageUrl(url)) {
      const converted = await convertToDataUrl(url, supabase);
      if (converted) {
        results.push(converted);
      } else {
        failed.push(url);
      }
    } else {
      // Non-supabase URLs are passed through (but likely will be blocked by SiteGround)
      results.push(url);
    }
  }
  if (failed.length > 0) {
    console.warn(`⚠ ${failed.length} images removed (not found in storage): ${failed.map(u => extractStoragePath(u) || u).join(', ')}`);
  }
  return results;
}

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

const SKU_LOOKUP_STATUSES = ['publish', 'draft', 'pending', 'private', 'trash'];

function normalizeSkuValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

async function queryWooProductsByParams(
  wooConfig: WooCommerceConfig,
  params: Record<string, string>
): Promise<any[]> {
  const url = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }
  url.searchParams.append('consumer_key', wooConfig.consumerKey);
  url.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const response = await fetchWithRetry(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; PIM-Sync/1.0)',
    },
  }, 3);

  const responseText = await response.text();
  if (!response.ok) {
    console.warn(
      `Woo SKU lookup failed (${params.status || 'default'}): ${response.status} - ${responseText.substring(0, 180)}`
    );
    return [];
  }

  try {
    const data = JSON.parse(responseText);
    return Array.isArray(data) ? data : [];
  } catch {
    console.warn(`Woo SKU lookup returned invalid JSON: ${responseText.substring(0, 180)}`);
    return [];
  }
}

async function findWooProductBySkuRobust(
  sku: string,
  wooConfig: WooCommerceConfig
): Promise<any | null> {
  const normalizedSku = normalizeSkuValue(sku);
  if (!normalizedSku) return null;

  // Strategy 1: SKU lookup without status filter (most reliable)
  const defaultProducts = await queryWooProductsByParams(wooConfig, {
    sku,
    per_page: '20',
  });
  const defaultMatch = defaultProducts.find((p: any) => normalizeSkuValue(p?.sku) === normalizedSku);
  if (defaultMatch) return defaultMatch;

  // Strategy 2: exact SKU lookups per status
  for (const status of SKU_LOOKUP_STATUSES) {
    const products = await queryWooProductsByParams(wooConfig, {
      sku,
      status,
      per_page: '20',
    });
    const match = products.find((p: any) => normalizeSkuValue(p?.sku) === normalizedSku);
    if (match) return match;
  }

  // Strategy 3: broader search, then exact SKU match in returned payload
  const searchProducts = await queryWooProductsByParams(wooConfig, {
    search: sku,
    per_page: '100',
  });
  const searchMatch = searchProducts.find((p: any) => normalizeSkuValue(p?.sku) === normalizedSku);
  if (searchMatch) return searchMatch;

  return null;
}

async function restoreWooProductFromTrash(
  wooProductId: number,
  wooConfig: WooCommerceConfig
): Promise<number | null> {
  const restoreUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
  restoreUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  restoreUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const restoreResponse = await fetchWithRetry(restoreUrl.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'draft' }),
  }, 3);

  const responseText = await restoreResponse.text();
  if (!restoreResponse.ok) {
    console.warn(`Failed to restore trashed product ${wooProductId}: ${restoreResponse.status} - ${responseText.substring(0, 200)}`);
    return null;
  }

  try {
    const restored = JSON.parse(responseText);
    console.log(`Restored trashed Woo product ${wooProductId} to status ${restored?.status || 'draft'}`);
    return restored?.id || wooProductId;
  } catch {
    console.warn(`Restored product ${wooProductId}, but response JSON parse failed`);
    return wooProductId;
  }
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

// Helper: ensure a single size term exists in the global pa_maat attribute
// Used by createVariationsInWooCommerce and createMissingVariation
async function ensureSizeTermExists(maatAttrId: number, termValue: string, wooConfig: WooCommerceConfig): Promise<void> {
  try {
    const termsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes/${maatAttrId}/terms`);
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
        const createTermUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/attributes/${maatAttrId}/terms`);
        createTermUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
        createTermUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

        const createRes = await fetchWithRetry(createTermUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: termValue }),
        });

        if (createRes.ok) {
          console.log(`✓ Registered Maat term: "${termValue}" in global pa_maat (ID ${maatAttrId})`);
        } else {
          const errText = await createRes.text();
          // term_exists means it's already there — safe to ignore
          if (!errText.includes('term_exists')) {
            console.warn(`Could not register Maat term "${termValue}": ${errText.substring(0, 150)}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error ensuring size term "${termValue}":`, err);
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

    console.log(`Processing ${jobs.length} sync jobs sequentially`);

    // Process all jobs sequentially and await completion
    // Edge functions terminate async work after returning, so we must await
    const results = await Promise.allSettled(
      jobs.map((job) => processJob(job, supabase, isSchedulerInvoked))
    );
    const successCount = results.filter((r) => r.status === 'fulfilled').length;
    const failureCount = results.filter((r) => r.status === 'rejected').length;
    console.log(`Sync complete: ${successCount} succeeded, ${failureCount} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Processed ${jobs.length} sync jobs: ${successCount} succeeded, ${failureCount} failed`,
        jobIds: jobs.map((j: any) => j.id),
        successCount,
        failureCount,
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

    // Process all products internally in sequential batches to avoid creating extra jobs
    const BATCH_SIZE = 5;
    const allProductIds = productIds || [];
    const totalProducts = allProductIds.length;
    
    if (totalProducts === 0 && (!variantIds || variantIds.length === 0)) {
      console.log('No productIds or variantIds in job payload - marking as done');
      await supabase.from('jobs').update({ state: 'done', error: 'No products specified' }).eq('id', job.id);
      return;
    }

    console.log(`Processing ${totalProducts} products in internal batches of ${BATCH_SIZE}`);
    let totalSynced = 0;
    let totalFailed = 0;
    let totalProcessed = 0;
    const failedProducts: Array<{ sku: string; productId: string; error: string; errorType: string }> = [];

    // Helper: write progress to job payload so the UI can show a live progress bar
    const updateProgress = async () => {
      await supabase.from('jobs').update({
        payload: {
          ...job.payload,
          progress: { processed: totalProcessed, total: totalProducts, synced: totalSynced, failed: totalFailed },
        },
        updated_at: new Date().toISOString(),
      }).eq('id', job.id);
    };

    // Process in sequential batches without creating new jobs
    for (let offset = 0; offset < Math.max(totalProducts, 1); offset += BATCH_SIZE) {
      const batchIds = totalProducts > 0 ? allProductIds.slice(offset, offset + BATCH_SIZE) : [];
      const batchNum = Math.floor(offset / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(totalProducts / BATCH_SIZE) || 1;
      
      console.log(`── Batch ${batchNum}/${totalBatches} (${batchIds.length} products) ──`);

      // Fetch products for this batch
      let query = supabase
        .from('products')
        .select(`
          *,
          brands(id, name),
          product_prices(*),
          variants(
            *,
            stock_totals(*)
          ),
          product_ai_content!product_ai_content_product_id_fkey (
            status, ai_title, ai_short_description, ai_long_description,
            ai_meta_title, ai_meta_description
          )
        `)
        .eq('tenant_id', job.tenant_id);

      if (batchIds.length > 0) {
        query = query.in('id', batchIds);
      } else if (variantIds && variantIds.length > 0) {
        const { data: variantData } = await supabase
          .from('variants')
          .select('product_id')
          .in('id', variantIds);
        if (variantData && variantData.length > 0) {
          const parentIds = [...new Set(variantData.map((v: any) => v.product_id))];
          query = query.in('id', parentIds);
        } else {
          break;
        }
      }

      const { data: products, error: productsError } = await query;
      if (productsError) throw productsError;
      if (!products || products.length === 0) {
        console.log(`Batch ${batchNum}: no products found, skipping`);
        continue;
      }

      // Process each product in this batch with delay — ISOLATE errors per product
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        try {
          await syncProductToWooCommerce(product, wooConfig, variantIds, supabase, job.tenant_id);
          totalSynced++;
          totalProcessed++;
          await updateProgress();
        } catch (productError: any) {
          totalFailed++;
          totalProcessed++;
          await updateProgress();
          const errMsg = productError instanceof Error ? productError.message : String(productError);
          const errType = classifyWooError(errMsg);
          
          console.error(`✗ Product ${product.sku} failed (${errType}): ${errMsg}`);
          failedProducts.push({
            sku: product.sku,
            productId: product.id,
            error: errMsg.substring(0, 500),
            errorType: errType,
          });

          // Log individual product failure to changelog
          await logChangeToChangelog(supabase, job.tenant_id, 'WOO_PUSH_FAILED', 
            `Push mislukt voor ${product.sku}: ${errType} — ${errMsg.substring(0, 150)}`,
            {
              productId: product.id,
              sku: product.sku,
              errorType: errType,
              error: errMsg.substring(0, 500),
              jobId: job.id,
              retryable: errType !== 'validation',
            }
          );

          // Queue retryable failures for automatic retry
          if (errType !== 'validation') {
            try {
              await supabase.from('pending_product_syncs').upsert({
                product_id: product.id,
                tenant_id: job.tenant_id,
                reason: `auto_retry:${errType}`,
                created_at: new Date().toISOString(),
              }, { onConflict: 'product_id,reason' });
            } catch (_e) { /* ignore upsert failures */ }
          }
        }
        
        // 3s delay between products to respect rate limits
        if (i < products.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      // 5s cooldown between batches to prevent SiteGround blocks
      if (offset + BATCH_SIZE < totalProducts) {
        console.log(`Batch ${batchNum} done, cooling down 5s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    console.log(`All batches complete: ${totalSynced} synced, ${totalFailed} failed out of ${totalProducts}`);

    // Determine job final state
    const jobError = totalFailed > 0
      ? `${totalSynced}/${totalProducts} synced, ${totalFailed} failed: ${failedProducts.slice(0, 3).map(f => `${f.sku}(${f.errorType})`).join(', ')}${failedProducts.length > 3 ? '...' : ''}`
      : null;

    // Mark job as done (even with partial failures — failed products are queued for retry)
    await supabase.from('jobs').update({ 
      state: totalSynced === 0 && totalFailed > 0 ? 'error' : 'done', 
      error: jobError,
      updated_at: new Date().toISOString(),
    }).eq('id', job.id);
      
    // Log summary to changelog
    await logChangeToChangelog(supabase, job.tenant_id, 
      totalFailed > 0 ? 'SYNC_PARTIAL' : 'SYNC_COMPLETED',
      totalFailed > 0
        ? `WooCommerce sync: ${totalSynced}/${totalProducts} gelukt, ${totalFailed} mislukt`
        : `${totalSynced} producten gesynchroniseerd naar WooCommerce`,
      {
        productCount: totalProducts,
        synced: totalSynced,
        failed: totalFailed,
        jobId: job.id,
        failedProducts: failedProducts.slice(0, 10),
      }
    );
    
    console.log(`Job ${job.id} completed: ${totalSynced} synced, ${totalFailed} failed`);
  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorType = classifyWooError(errorMessage);
    const attempts = (job as any).attempts + 1;
    const maxRetries = 5;

    // Retry transient errors (timeouts, rate limits, network issues)
    const shouldRetry = attempts < maxRetries && errorType !== 'validation';

    if (shouldRetry) {
      const backoffSeconds = Math.min(Math.pow(2, attempts) * 15, 600);
      console.log(`Retrying job ${job.id} in ${backoffSeconds}s (attempt ${attempts}/${maxRetries}, type: ${errorType})`);
      
      await supabase
        .from('jobs')
        .update({ 
          state: 'ready', 
          error: `Retry ${attempts}/${maxRetries} (${errorType}): ${errorMessage.substring(0, 200)}`,
          updated_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
        })
        .eq('id', job.id);

      await logChangeToChangelog(supabase, job.tenant_id, 'WOO_JOB_RETRY',
        `Job retry ${attempts}/${maxRetries}: ${errorType} — ${errorMessage.substring(0, 100)}`,
        { jobId: job.id, attempts, maxRetries, errorType, error: errorMessage.substring(0, 500) }
      );
    } else {
      await supabase
        .from('jobs')
        .update({ state: 'error', error: `${errorType}: ${errorMessage}` })
        .eq('id', job.id);
      
      await logChangeToChangelog(supabase, job.tenant_id, 'SYNC_FAILED',
        `WooCommerce sync definitief mislukt (${errorType}) na ${attempts} pogingen`,
        { error: errorMessage, attempts, jobId: job.id, errorType }
      );
    }

    throw error;
  }
}

/** Classify WooCommerce errors for smart retry decisions */
function classifyWooError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('stale sku conflict')) return 'stale_sku';
  if (lower.includes('504') || lower.includes('timeout') || lower.includes('etimedout')) return 'timeout';
  if (lower.includes('429') || lower.includes('rate limit')) return 'rate_limit';
  if (lower.includes('502') || lower.includes('503') || lower.includes('529')) return 'server_error';
  if (lower.includes('bot protection') || lower.includes('blocked') || lower.includes('captcha') || lower.includes('cloudflare')) return 'bot_protection';
  if (lower.includes('econnreset') || lower.includes('network') || lower.includes('fetch') || lower.includes('peer closed') || lower.includes('unexpected eof')) return 'network';
  if (lower.includes('400') || lower.includes('bad request') || lower.includes('invalid')) return 'validation';
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid_username')) return 'auth';
  if (lower.includes('403') || lower.includes('forbidden')) return 'forbidden';
  return 'unknown';
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

  // ── PREFLIGHT CHECK 1: Use products.woocommerce_product_id if already known ──
  if (product.woocommerce_product_id) {
    console.log(`Product ${sku} has stored woocommerce_product_id=${product.woocommerce_product_id}, updating directly`);
    await updateProductInWooCommerce(product.woocommerce_product_id, product, wooConfig, variantIdsFilter, supabase, tenantId);
    return;
  }

  // ── PREFLIGHT CHECK 2: Check local woo_products cache before hitting WC API ──
  if (supabase && tenantId) {
    const { data: cachedWoo } = await supabase
      .from('woo_products')
      .select('woo_id, status')
      .eq('tenant_id', tenantId)
      .eq('sku', sku)
      .maybeSingle();

    if (cachedWoo?.woo_id) {
      console.log(`Product ${sku} found in local cache (woo_id: ${cachedWoo.woo_id}), updating via cache`);
      // Backfill woocommerce_product_id so we don't need cache next time
      await supabase.from('products').update({ woocommerce_product_id: cachedWoo.woo_id }).eq('id', product.id);
      if (cachedWoo.status === 'trash') {
        await restoreWooProductFromTrash(cachedWoo.woo_id, wooConfig);
      }
      await updateProductInWooCommerce(cachedWoo.woo_id, product, wooConfig, variantIdsFilter, supabase, tenantId);
      return;
    }
  }

  // ── STANDARD FLOW: Find WooCommerce product by SKU via API ──
  const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
  searchUrl.searchParams.append('sku', sku);
  searchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  searchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
  
  const searchResponse = await fetchWithRetry(searchUrl.toString(), {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; PIM-Sync/1.0)',
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

  // Product exists, update it — and backfill woocommerce_product_id
  const wooProduct = wooProducts[0];
  const wooProductId = wooProduct.id;
  console.log(`Found WooCommerce product ID ${wooProductId} for SKU ${sku}, updating`);

  if (supabase && tenantId && !product.woocommerce_product_id) {
    await supabase.from('products').update({ 
      woocommerce_product_id: wooProductId,
      woo_slug: wooProduct.slug || null,
      woo_permalink: wooProduct.permalink || null,
    }).eq('id', product.id);
  }

  await updateProductInWooCommerce(wooProductId, product, wooConfig, variantIdsFilter, supabase, tenantId);
}

async function createProductInWooCommerce(
  product: any,
  wooConfig: WooCommerceConfig,
  variantIdsFilter?: string[],
  supabase?: any,
  tenantId?: string
) {
  const { sku, product_prices, variants, images, color, brands, tax_code, webshop_text, meta_description, categories, attributes, product_ai_content } = product;

  // Use approved AI content if available
  const aiContent = product_ai_content as any;
  const hasApprovedAi = aiContent?.status === 'approved';
  const title = (hasApprovedAi && aiContent.ai_title) || product.title;
  const description = (hasApprovedAi && aiContent.ai_long_description) || webshop_text || '';
  const shortDescription = (hasApprovedAi && aiContent.ai_short_description) || meta_description || '';

  if (hasApprovedAi) {
    console.log(`Using approved AI content for new product ${sku}: title="${title}"`);
  }

  // Prepare product images - convert relative storage paths to absolute public URLs
  // WooCommerce downloads images from URLs directly; data: URLs are NOT supported
  const storageBaseUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/product-images/`;
  const originalImageCount = (images || []).filter((img: string) => img && img.trim().length > 0).length;
  let imageUrls = (images || [])
    .filter((img: string) => img && img.trim().length > 0)
    .map((img: string) => {
      if (img.startsWith('http://') || img.startsWith('https://')) return img;
      return `${storageBaseUrl}${img}`;
    });

  // Verify images exist in storage before sending to WooCommerce
  if (imageUrls.length > 0 && supabase) {
    const verified: string[] = [];
    const missing: string[] = [];
    for (const url of imageUrls) {
      if (isSupabaseStorageUrl(url)) {
        const storagePath = extractStoragePath(url);
        if (storagePath) {
          // Check if file exists by trying to download first byte
          const { data, error } = await supabase.storage
            .from('product-images')
            .download(storagePath, { transform: { width: 1, height: 1 } });
          if (error || !data) {
            missing.push(storagePath);
          } else {
            verified.push(url);
          }
        } else {
          verified.push(url);
        }
      } else {
        verified.push(url);
      }
    }
    if (missing.length > 0) {
      console.warn(`⚠ ${missing.length} images not found in storage, skipped: ${missing.join(', ')}`);
    }
    imageUrls = verified;
  }
  imageUrls = imageUrls.filter((url: string) => url && url.trim().length > 0);
  const productImages = imageUrls.map((src: string) => ({ src }));

  // Track missing images in image_sync_status for later retry
  const missingImageCount = originalImageCount - imageUrls.length;
  if (missingImageCount > 0 && supabase && tenantId) {
    console.warn(`Product ${sku}: ${missingImageCount}/${originalImageCount} images missing from storage`);
    await supabase.from('image_sync_status').upsert({
      product_id: product.id,
      tenant_id: tenantId,
      status: 'failed',
      image_count: originalImageCount,
      uploaded_count: imageUrls.length,
      failed_count: missingImageCount,
      error_message: `${missingImageCount} afbeeldingen niet gevonden in storage`,
      push_attempted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'product_id' });
  }

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
  
  // Build product attributes array using global IDs — NEVER use id: 0 for Maat
  const maatAttrDef: any = {
    name: 'Maat',
    position: 0,
    visible: true,
    variation: true,
    options: sizeOptions
  };
  if (globalMaatId > 0) {
    maatAttrDef.id = globalMaatId;
  }
  const productAttributes: any[] = [maatAttrDef];

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
    // Track IDs and names already in productAttributes to prevent duplicates
    const usedAttrIds = new Set<number>(productAttributes.filter((a: any) => a.id > 0).map((a: any) => a.id));
    const usedAttrNames = new Set<string>(productAttributes.map((a: any) => (a.name || '').toLowerCase()).filter(Boolean));
    for (const [key, value] of Object.entries(mappedAttributes)) {
      const valueStr = String(value).trim();
      if (!valueStr || key.toLowerCase() === 'maat' || key.toLowerCase() === 'merk' || key.toLowerCase() === 'kleur') continue;
      
      const globalAttr = findGlobalAttribute(key);
      
      // Skip if global ID already used
      if (globalAttr?.id && usedAttrIds.has(globalAttr.id)) continue;
      // Skip if name already used
      if (usedAttrNames.has(key.toLowerCase())) continue;
      
      if (globalAttr?.id) {
        await ensureAttributeTerm(globalAttr.id, valueStr);
        console.log(`Using global attribute "${key}" (ID: ${globalAttr.id}) for new product`);
        usedAttrIds.add(globalAttr.id);
      }
      usedAttrNames.add(key.toLowerCase());
      
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
    description: description,
    short_description: shortDescription,
    images: productImages,
    attributes: productAttributes,
    tax_class: tax_code || '',
  };

  // Add categories if available - ensure they exist first, apply mappings
  console.log(`Product ${sku} has categories:`, categories);
  if (categories && Array.isArray(categories) && categories.length > 0) {
    // Fetch category mappings
    let categoryMappings: Record<string, string> = {};
    if (supabase && tenantId) {
      try {
        const { data: mappingsData } = await supabase
          .from('woo_category_mappings')
          .select('source_category, woo_category')
          .eq('tenant_id', tenantId);
        if (mappingsData) {
          for (const m of mappingsData) {
            categoryMappings[m.source_category] = m.woo_category;
          }
        }
      } catch (err) {
        console.error('Error loading category mappings:', err);
      }
    }

    const categoryIds: number[] = [];
    for (const cat of categories) {
      if (cat.name) {
        const targetName = categoryMappings[cat.name] || cat.name;
        if (targetName !== cat.name) {
          console.log(`Mapped category "${cat.name}" -> "${targetName}"`);
        }
        const catId = await ensureCategoryExists(targetName, wooConfig);
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
    
    // If image upload error, retry WITHOUT images so the product still gets created
    if (errorData.code === 'woocommerce_product_image_upload_error') {
      console.warn(`Product ${sku}: image upload failed, retrying create WITHOUT images`);
      
      // Log the image failure
      if (supabase && tenantId) {
        await logChangeToChangelog(supabase, tenantId, 'WOO_IMAGE_UPLOAD_FAILED',
          `Afbeeldingen konden niet worden geüpload voor ${sku} — product wordt zonder afbeeldingen aangemaakt`,
          { sku, imageCount: productImages.length, error: errorData.message?.substring(0, 200) }
        );
      }

      const retryData = { ...productData, images: [] };
      const retryResponse = await fetchWithRetry(createUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryData),
      });

      if (retryResponse.ok) {
        const createdProduct = await retryResponse.json();
        console.log(`Created product ${sku} (without images) with ID ${createdProduct.id}`);

        if (supabase && tenantId) {
          await logChangeToChangelog(supabase, tenantId, 'WOO_PRODUCT_CREATED',
            `Nieuw product aangemaakt in WooCommerce (zonder afbeeldingen): ${title} (${sku})`,
            { productId: product.id, sku, title, wooProductId: createdProduct.id, variantCount: variantsToCreate?.length || 0, imagesSkipped: true }
          );
          await upsertWooProductCache(supabase, tenantId, createdProduct.id, product.id, sku, title, createdProduct.slug, createdProduct.status, createdProduct.type);
        }

        if (variantsToCreate && variantsToCreate.length > 0) {
          await createVariationsInWooCommerce(createdProduct.id, variantsToCreate, product_prices, wooConfig, sku, globalMaatId);
        }
        return;
      }
      // If retry also failed, check if SKU already exists
      const retryErrorText = await retryResponse.text();
      let retryErrorData;
      try { retryErrorData = JSON.parse(retryErrorText); } catch { /* ignore */ }
      if (retryErrorData?.code !== 'woocommerce_rest_product_not_created') {
        throw new Error(`Failed to create product ${sku} (no images): ${retryResponse.status} - ${retryErrorText.substring(0, 300)}`);
      }
    }

    // If product already exists (SKU duplicate), find and update it
    if ((errorData.code === 'woocommerce_rest_product_not_created' && errorData.message?.includes('SKU')) ||
        errorData.code === 'woocommerce_product_image_upload_error') {
      const reason = errorData.code === 'woocommerce_product_image_upload_error' ? 'has image errors' : 'already exists';
      console.log(`Product ${sku} ${reason}, searching for it to update`);

      const existingProduct = await findWooProductBySkuRobust(sku, wooConfig);
      if (existingProduct?.id) {
        let existingProductId = existingProduct.id;

        if (existingProduct.status === 'trash') {
          const restoredId = await restoreWooProductFromTrash(existingProduct.id, wooConfig);
          if (restoredId) {
            existingProductId = restoredId;
          }
        }

        console.log(`Found existing product ${sku} with ID ${existingProductId}, updating instead`);
        await updateProductInWooCommerce(existingProductId, product, wooConfig, variantIdsFilter, supabase, tenantId);
        return;
      }

      // Fallback 1: check local woo_products cache
      if (supabase && tenantId) {
        const { data: cachedWoo } = await supabase
          .from('woo_products')
          .select('woo_id, status')
          .eq('tenant_id', tenantId)
          .eq('sku', sku)
          .maybeSingle();

        if (cachedWoo?.woo_id) {
          console.log(`Found SKU ${sku} in local cache (woo_id: ${cachedWoo.woo_id}), updating via cache fallback`);
          if (cachedWoo.status === 'trash') {
            await restoreWooProductFromTrash(cachedWoo.woo_id, wooConfig);
          }
          await supabase.from('products').update({ woocommerce_product_id: cachedWoo.woo_id }).eq('id', product.id);
          await updateProductInWooCommerce(cachedWoo.woo_id, product, wooConfig, variantIdsFilter, supabase, tenantId);
          return;
        }

        // Fallback 2: check products.woocommerce_product_id
        if (product.woocommerce_product_id) {
          console.log(`Found SKU ${sku} via products.woocommerce_product_id (${product.woocommerce_product_id}), updating`);
          await updateProductInWooCommerce(product.woocommerce_product_id, product, wooConfig, variantIdsFilter, supabase, tenantId);
          return;
        }
      }

      // Fallback 3: Try wc-analytics/products endpoint (bypasses regular search, queries lookup table directly)
      try {
        const analyticsUrl = new URL(`${wooConfig.url}/wp-json/wc-analytics/products`);
        analyticsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
        analyticsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
        analyticsUrl.searchParams.append('search', sku);
        analyticsUrl.searchParams.append('per_page', '20');

        const analyticsResponse = await fetchWithRetry(analyticsUrl.toString(), {
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; PIM-Sync/1.0)' },
        }, 2);

        if (analyticsResponse.ok) {
          const analyticsText = await analyticsResponse.text();
          try {
            const analyticsProducts = JSON.parse(analyticsText);
            const match = Array.isArray(analyticsProducts)
              ? analyticsProducts.find((p: any) => normalizeSkuValue(p?.sku) === normalizeSkuValue(sku))
              : null;
            if (match?.id) {
              console.log(`Found SKU ${sku} via wc-analytics endpoint (ID: ${match.id}), updating`);
              if (supabase && tenantId) {
                await supabase.from('products').update({ woocommerce_product_id: match.id }).eq('id', product.id);
              }
              await updateProductInWooCommerce(match.id, product, wooConfig, variantIdsFilter, supabase, tenantId);
              return;
            }
          } catch { /* non-JSON response, continue */ }
        }
      } catch (err) {
        console.warn(`wc-analytics fallback failed for ${sku}:`, err);
      }

      // Fallback 4: Purge stale SKU from WC lookup table by deleting+recreating
      // WooCommerce has a known issue where deleted products leave orphaned entries in wp_wc_product_meta_lookup
      // Try to clear the stale entry by calling the system status tools API
      console.warn(`SKU conflict for ${sku}: product exists in WC lookup table but cannot be found via any API. Attempting stale entry cleanup...`);
      try {
        // Use the WC system status tools to regenerate the lookup table for this SKU
        const toolUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/system_status/tools/clear_transients`);
        toolUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
        toolUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
        
        await fetchWithRetry(toolUrl.toString(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        }, 1);
        console.log(`Cleared WC transients cache for SKU ${sku}`);
      } catch (cleanupErr) {
        console.warn(`Could not clear WC transients:`, cleanupErr);
      }

      // Reclassify as a retryable "stale_sku" error instead of permanent "validation"
      throw new Error(`Stale SKU conflict for ${sku}: product exists in WC lookup table but API search returns nothing. Transient cache cleared — retry should succeed. Original: ${JSON.stringify(errorData).substring(0, 200)}`);
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
    await upsertWooProductCache(supabase, tenantId, createdProduct.id, product.id, sku, title, createdProduct.slug, createdProduct.status, createdProduct.type);
  }

  // Create variations — pass globalMaatId for proper attribute linking
  if (variantsToCreate && variantsToCreate.length > 0) {
    await createVariationsInWooCommerce(createdProduct.id, variantsToCreate, product_prices, wooConfig, sku, globalMaatId);
  }
}

async function createVariationsInWooCommerce(
  wooProductId: number,
  variants: any[],
  product_prices: any,
  wooConfig: WooCommerceConfig,
  parentSku: string,
  globalMaatId: number = 0
) {
  console.log(`Creating ${variants.length} variations for product ${wooProductId} with parent SKU ${parentSku}, globalMaatId=${globalMaatId}`);
  
  // Build attribute reference — use global ID when available, NEVER id: 0
  const attrRef = globalMaatId > 0 ? { id: globalMaatId } : { name: 'pa_maat' };

  // --- Ensure all size terms exist in global pa_maat BEFORE creating any variation ---
  if (globalMaatId > 0) {
    const sizeLabels = variants.map((v: any) => v.size_label).filter(Boolean);
    for (const label of sizeLabels) {
      await ensureSizeTermExists(globalMaatId, label, wooConfig);
    }
    console.log(`Ensured ${sizeLabels.length} size terms exist for pa_maat (ID ${globalMaatId})`);
  }

  // Build all variation payloads for batch API
  const batchCreate: any[] = [];
  for (const variant of variants) {
    const maatSuffix = variant.maat_id && variant.maat_id.includes('-') ? variant.maat_id.split('-').pop() : variant.maat_id;
    const variationSku = parentSku && maatSuffix ? `${parentSku}-${maatSuffix}` : (variant.ean || '');
    
    const variationData: any = {
      attributes: [
        { ...attrRef, option: variant.size_label }
      ],
      sku: variationSku,
      manage_stock: true,
      stock_quantity: variant.stock_totals?.qty || 0,
      stock_status: (variant.stock_totals?.qty || 0) > 0 ? 'instock' : 'outofstock',
    };

    if (product_prices?.regular) {
      variationData.regular_price = product_prices.regular.toString();
    }
    if (product_prices?.list) {
      variationData.sale_price = product_prices.list.toString();
    }
    if (variant.ean) {
      variationData.meta_data = [{ key: 'ean', value: variant.ean }];
    }

    batchCreate.push(variationData);
  }

  // Use WooCommerce Batch API to create all variations in one call
  const batchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/batch`);
  batchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  batchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const batchResponse = await fetchWithRetry(batchUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ create: batchCreate }),
  });

  if (!batchResponse.ok) {
    const errorText = await batchResponse.text();
    console.error(`Batch variation create failed: ${errorText.substring(0, 300)}`);
    // Fallback: create one by one
    console.log('Falling back to individual variation creation...');
    for (const variationData of batchCreate) {
      const createVariationUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
      createVariationUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
      createVariationUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

      const createResponse = await fetchWithRetry(createVariationUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(variationData),
      });

      if (!createResponse.ok) {
        const errText = await createResponse.text();
        console.error(`Failed to create variation ${variationData.attributes?.[0]?.option}: ${errText}`);
        continue;
      }
      console.log(`Created variation ${variationData.attributes?.[0]?.option} for product ${wooProductId}`);
    }
    return;
  }

  const batchResult = await batchResponse.json();
  const created = batchResult.create || [];
  console.log(`Batch created ${created.length}/${batchCreate.length} variations for product ${wooProductId}`);
  
  // Log any individual errors from the batch response
  for (const item of created) {
    if (item.error) {
      console.error(`Batch variation error (${item.sku || 'unknown'}): ${item.error.message}`);
    }
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
  productTitle?: string,
  globalMaatId: number = 0
): Promise<any | null> {
  // Build variation SKU - extract suffix from maat_id to avoid double-prefixing
  const maatSuffix = variant.maat_id && variant.maat_id.includes('-') ? variant.maat_id.split('-').pop() : variant.maat_id;
  const variationSku = parentSku && maatSuffix ? `${parentSku}-${maatSuffix}` : (variant.ean || '');

  // Build attribute reference — use global ID when available, NEVER id: 0
  const attrRef = globalMaatId > 0 ? { id: globalMaatId } : { name: 'pa_maat' };

  // --- Ensure size term exists in global pa_maat BEFORE creating the variation ---
  if (globalMaatId > 0 && variant.size_label) {
    await ensureSizeTermExists(globalMaatId, variant.size_label, wooConfig);
    console.log(`Ensured size term "${variant.size_label}" exists for pa_maat (ID ${globalMaatId})`);
  }
  
  const variationData: any = {
    attributes: [
      { ...attrRef, option: variant.size_label }
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
  const { sku, variants, images, product_prices, webshop_text, meta_description, categories, brands, attributes, color, product_ai_content } = product;

  // Use approved AI content if available
  const aiContent = product_ai_content as any;
  const hasApprovedAi = aiContent?.status === 'approved';
  const title = (hasApprovedAi && aiContent.ai_title) || product.title;
  const description = (hasApprovedAi && aiContent.ai_long_description) || webshop_text;
  const shortDescription = (hasApprovedAi && aiContent.ai_short_description) || meta_description;

  if (hasApprovedAi) {
    console.log(`Using approved AI content for update ${sku}: title="${title}"`);
  }

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
  const storageBaseUrlUpdate = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/product-images/`;
  const filteredNewImages = (images || [])
    .filter((img: string) => img && img.trim().length > 0)
    .map((img: string) => {
      if (!img.startsWith('http://') && !img.startsWith('https://')) {
        return `${storageBaseUrlUpdate}${img}`;
      }
      return img;
    })
    .filter((img: string) => {
      try {
        const url = new URL(img);
        const pathname = url.pathname;
        const filename = pathname.split('/').pop() || '';
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
    });

  // Use public storage URLs directly (WooCommerce downloads them; data: URLs are NOT supported)
  let convertedNewImages = filteredNewImages.filter((img: string) => img && img.trim().length > 0);
  const newImagesToAdd = convertedNewImages.map((img: string) => ({ src: img }));

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

  // Prepare product update data with descriptions, title, and categories
  const updateData: any = {};

  // Always push title (AI or PIM)
  updateData.name = title;
  
  if (description) {
    updateData.description = description;
  }
  
  if (shortDescription) {
    updateData.short_description = shortDescription;
  }
  
  // Update categories - MERGE with existing WooCommerce categories (don't replace)
  console.log(`Product ${sku} has categories:`, categories);
  if (categories && Array.isArray(categories) && categories.length > 0) {
    // Fetch category mappings from woo_category_mappings table
    let categoryMappings: Record<string, string> = {};
    if (supabase && tenantId) {
      try {
        const { data: mappingsData } = await supabase
          .from('woo_category_mappings')
          .select('source_category, woo_category')
          .eq('tenant_id', tenantId);
        if (mappingsData) {
          for (const m of mappingsData) {
            categoryMappings[m.source_category] = m.woo_category;
          }
          console.log(`Loaded ${Object.keys(categoryMappings).length} category mappings`);
        }
      } catch (err) {
        console.error('Error loading category mappings:', err);
      }
    }

    // Get existing WooCommerce category IDs from the fetched product
    const existingCatIds = new Set<number>(
      (existingProduct.categories || []).map((c: any) => c.id).filter(Boolean)
    );
    console.log(`Product ${sku} has ${existingCatIds.size} existing WooCommerce categories`);

    const newCategoryIds: number[] = [];
    for (const cat of categories) {
      if (cat.name) {
        // Apply mapping: translate source category to WooCommerce category if mapped
        const targetName = categoryMappings[cat.name] || cat.name;
        if (targetName !== cat.name) {
          console.log(`Mapped category "${cat.name}" -> "${targetName}"`);
        }
        const catId = await ensureCategoryExists(targetName, wooConfig);
        if (catId) {
          newCategoryIds.push(catId);
        }
      }
    }

    // Merge: existing + new, deduplicate
    const mergedCatIds = new Set<number>([...existingCatIds, ...newCategoryIds]);
    if (mergedCatIds.size > 0) {
      updateData.categories = Array.from(mergedCatIds).map(id => ({ id }));
      console.log(`Merged categories: ${existingCatIds.size} existing + ${newCategoryIds.length} new = ${mergedCatIds.size} total`);
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
    // Track used IDs and names to prevent duplicates
    const usedAttrIds = new Set<number>(updatedAttributes.filter((a: any) => a.id > 0).map((a: any) => a.id));
    
    for (const [attrName, attrValue] of Object.entries(mappedAttributes)) {
      const valueStr = String(attrValue).trim();
      if (!valueStr) continue;
      
      // Skip if it's Maat or Merk (already handled separately)
      if (attrName.toLowerCase() === 'maat' || attrName.toLowerCase() === 'merk') continue;
      
      // Try to find a global attribute for this name
      const globalAttr = findGlobalAttribute(attrName);
      
      // Check if this attribute already exists in the product - match by ID first, then name
      let existingIndex = -1;
      if (globalAttr?.id) {
        existingIndex = updatedAttributes.findIndex((a: any) => a.id === globalAttr.id);
      }
      if (existingIndex < 0) {
        existingIndex = updatedAttributes.findIndex((a: any) => 
          a.name?.toLowerCase() === attrName.toLowerCase() ||
          a.slug?.toLowerCase() === attrName.toLowerCase().replace(/\s+/g, '-')
        );
      }
      
      // Skip if global ID already used by another attr at a different position
      if (globalAttr?.id && usedAttrIds.has(globalAttr.id) && existingIndex < 0) continue;
      
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
        usedAttrIds.add(globalAttr.id);
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
    
    // Check if Merk attribute already exists - by ID first, then name/slug
    let merkIndex = globalBrand?.id ? updatedAttributes.findIndex((a: any) => a.id === globalBrand.id) : -1;
    if (merkIndex < 0) {
      merkIndex = updatedAttributes.findIndex((a: any) => 
        a.name?.toLowerCase() === 'merk' ||
        a.slug?.toLowerCase() === 'merk' ||
        a.slug?.toLowerCase() === 'pa_merk'
      );
    }
    
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
      // Invalidate local cache so sync-new-products won't re-queue this product
      if (supabase && tenantId) {
        await upsertWooProductCache(supabase, tenantId, wooProductId, product.id, sku, title, undefined, undefined, product.product_type);
      }
    }
  }

  console.log(`Updating product ${sku}, will set prices on variations`);

  // Update variants using WooCommerce Batch API for efficiency
  if (variants && variants.length > 0) {
    const variantsToSync = variantIdsFilter 
      ? variants.filter((v: any) => variantIdsFilter.includes(v.id))
      : variants;

    await batchSyncVariantsToWooCommerce(
      wooProductId,
      variantsToSync,
      product_prices,
      wooConfig,
      supabase,
      tenantId,
      sku,
      title,
      globalMaatId
    );
  }
}

/** Batch sync all variants for a product using WooCommerce /variations/batch API */
async function batchSyncVariantsToWooCommerce(
  wooProductId: number,
  variants: any[],
  product_prices: any,
  wooConfig: WooCommerceConfig,
  supabase?: any,
  tenantId?: string,
  productSku?: string,
  productTitle?: string,
  globalMaatId: number = 0
) {
  // 1. Fetch ALL WooCommerce variations for this product ONCE
  const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
  variationsUrl.searchParams.append('per_page', '100');
  variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
  
  const variationsResponse = await fetchWithRetry(variationsUrl.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!variationsResponse.ok) {
    console.error(`Failed to fetch variations for product ${wooProductId}, falling back to individual sync`);
    for (const variant of variants) {
      await syncVariantToWooCommerce(wooProductId, variant, product_prices, wooConfig, supabase, tenantId, productSku, productTitle, globalMaatId);
    }
    return;
  }

  const wooVariations = await variationsResponse.json();
  console.log(`Fetched ${wooVariations.length} WooCommerce variations for batch processing (product ${wooProductId})`);

  const normalizeSize = (size: string): string => size?.toLowerCase().trim().replace(/\s+/g, ' ') || '';

  // 2. Ensure all size terms exist BEFORE batching
  if (globalMaatId > 0) {
    for (const variant of variants) {
      if (variant.size_label) {
        await ensureSizeTermExists(globalMaatId, variant.size_label, wooConfig);
      }
    }
  }

  // 3. Match each DB variant to a WC variation and build batch payloads
  const batchUpdate: any[] = [];
  const batchCreate: any[] = [];

  for (const variant of variants) {
    const maatSuffix = variant.maat_id && variant.maat_id.includes('-') ? variant.maat_id.split('-').pop() : variant.maat_id;
    const expectedFullSku = productSku && maatSuffix ? `${productSku}-${maatSuffix}` : null;
    const legacyFullSku = productSku ? `${productSku}-${variant.size_label}` : null;

    // Find matching WC variation
    let matchingVariation = null;
    for (const wv of wooVariations) {
      // SKU match (new format)
      if (wv.sku && expectedFullSku && normalizeSize(wv.sku) === normalizeSize(expectedFullSku)) {
        matchingVariation = wv;
        break;
      }
      // Legacy SKU match
      if (wv.sku && legacyFullSku && normalizeSize(wv.sku) === normalizeSize(legacyFullSku)) {
        matchingVariation = wv;
        break;
      }
      // SKU suffix match
      if (wv.sku && wv.sku.endsWith(variant.size_label)) {
        matchingVariation = wv;
        break;
      }
      // Size attribute match
      const sizeAttr = wv.attributes?.find((a: any) => 
        ['size', 'maat', 'pa_size', 'pa_maat'].includes(a.name?.toLowerCase())
      );
      if (sizeAttr?.option && normalizeSize(variant.size_label) === normalizeSize(sizeAttr.option)) {
        matchingVariation = wv;
        break;
      }
    }

    // Build attribute reference
    const attrRef: any = globalMaatId > 0 ? { id: globalMaatId } : { name: 'pa_maat' };

    const variationPayload: any = {
      manage_stock: true,
      stock_quantity: variant.stock_totals?.qty || 0,
      stock_status: (variant.stock_totals?.qty || 0) > 0 ? 'instock' : 'outofstock',
      attributes: [{ ...attrRef, option: variant.size_label }],
    };

    if (product_prices?.regular) variationPayload.regular_price = product_prices.regular.toString();
    if (product_prices?.list) variationPayload.sale_price = product_prices.list.toString();
    if (variant.ean) variationPayload.meta_data = [{ key: 'ean', value: variant.ean }];

    if (matchingVariation) {
      // Update existing variation
      variationPayload.id = matchingVariation.id;
      // Update SKU if needed
      if (expectedFullSku && maatSuffix && maatSuffix.length === 6 && matchingVariation.sku !== expectedFullSku) {
        variationPayload.sku = expectedFullSku;
      }
      batchUpdate.push({ payload: variationPayload, old: matchingVariation, variant });
    } else {
      // Check if size already exists (prevent duplicates)
      const sizeExists = wooVariations.some((wv: any) => {
        const sa = wv.attributes?.find((a: any) => ['maat', 'pa_maat', 'size', 'pa_size'].includes(a.name?.toLowerCase()));
        return sa?.option && normalizeSize(sa.option) === normalizeSize(variant.size_label);
      });
      if (sizeExists) {
        console.warn(`Variation size "${variant.size_label}" already exists for WC #${wooProductId} — skipping`);
        continue;
      }
      // Create new variation
      const variationSku = expectedFullSku || (variant.ean || '');
      variationPayload.sku = variationSku;
      batchCreate.push({ payload: variationPayload, variant });
    }
  }

  // 4. Send batch request
  if (batchUpdate.length === 0 && batchCreate.length === 0) {
    console.log(`No variation changes needed for product ${wooProductId}`);
    return;
  }

  const batchBody: any = {};
  if (batchUpdate.length > 0) batchBody.update = batchUpdate.map(b => b.payload);
  if (batchCreate.length > 0) batchBody.create = batchCreate.map(b => b.payload);

  console.log(`Batch variations for WC #${wooProductId}: ${batchUpdate.length} update, ${batchCreate.length} create`);

  const batchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/batch`);
  batchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  batchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const batchResponse = await fetchWithRetry(batchUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchBody),
  });

  if (!batchResponse.ok) {
    const errorText = await batchResponse.text();
    console.error(`Batch variation update failed: ${errorText.substring(0, 300)}, falling back to individual sync`);
    for (const variant of variants) {
      await syncVariantToWooCommerce(wooProductId, variant, product_prices, wooConfig, supabase, tenantId, productSku, productTitle, globalMaatId);
    }
    return;
  }

  const batchResult = await batchResponse.json();
  const updatedItems = batchResult.update || [];
  const createdItems = batchResult.create || [];
  console.log(`Batch result: ${updatedItems.length} updated, ${createdItems.length} created for WC #${wooProductId}`);

  // 5. Log changes to changelog
  if (supabase && tenantId) {
    // Log updates
    for (let i = 0; i < batchUpdate.length; i++) {
      const { old: oldVar, variant } = batchUpdate[i];
      const changesArray = [];
      const newQty = variant.stock_totals?.qty || 0;
      if (oldVar.stock_quantity !== newQty) changesArray.push(`voorraad ${oldVar.stock_quantity} → ${newQty}`);
      if (product_prices?.regular && oldVar.regular_price !== product_prices.regular.toString()) {
        changesArray.push(`prijs ${oldVar.regular_price} → ${product_prices.regular}`);
      }
      if (changesArray.length > 0) {
        await logChangeToChangelog(supabase, tenantId, 'WOO_VARIANT_UPDATED',
          `Variant geüpdatet in WooCommerce: ${productTitle || 'Product'} (${productSku || 'N/A'}) - Maat ${variant.size_label}: ${changesArray.join(', ')}`,
          { variantId: variant.id, productSku, size: variant.size_label, wooProductId, wooVariationId: oldVar.id, changes: changesArray }
        );
      }
    }
    // Log creations
    for (let i = 0; i < batchCreate.length; i++) {
      const { variant } = batchCreate[i];
      const created = createdItems[i];
      if (created && !created.error) {
        await logChangeToChangelog(supabase, tenantId, 'WOO_VARIANT_CREATED',
          `Ontbrekende variatie aangemaakt in WooCommerce: ${productTitle || productSku} - Maat ${variant.size_label}`,
          { wooProductId, wooVariationId: created.id, size_label: variant.size_label, stock_quantity: variant.stock_totals?.qty || 0 }
        );
      }
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
  productTitle?: string,
  globalMaatId: number = 0
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
  
  // Build expected SKU - extract suffix from maat_id to avoid double-prefixing
  const maatSuffix = variant.maat_id && variant.maat_id.includes('-') ? variant.maat_id.split('-').pop() : variant.maat_id;
  const expectedFullSku = productSku && maatSuffix ? `${productSku}-${maatSuffix}` : null;
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
    // Safety check: verify no existing variation has this size_label before creating
    // This prevents duplicates when SKU format changes but size is the same
    const sizeAlreadyExists = wooVariations.some((wv: any) => {
      const sa = wv.attributes?.find((a: any) =>
        a.name?.toLowerCase() === 'maat' || a.name?.toLowerCase() === 'pa_maat' ||
        a.name?.toLowerCase() === 'size' || a.name?.toLowerCase() === 'pa_size'
      );
      return sa?.option && normalizeSize(sa.option) === normalizeSize(variant.size_label);
    });

    if (sizeAlreadyExists) {
      console.warn(`Variation with size "${variant.size_label}" already exists for WC #${wooProductId} but SKU didn't match — skipping creation to prevent duplicate`);
      return;
    }

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
      productTitle,
      globalMaatId
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

  // Update variation SKU to new format: {productSku}-{suffix}
  // Only update if suffix is a valid code and SKU differs
  if (expectedFullSku && maatSuffix && maatSuffix.length === 6) {
    const currentWooSku = matchingVariation.sku || '';
    if (currentWooSku !== expectedFullSku) {
      updateData.sku = expectedFullSku;
      console.log(`Updating variation SKU: "${currentWooSku}" → "${expectedFullSku}"`);
    }
  }

  // Ensure the size term exists in global pa_maat BEFORE setting it on the variation
  if (globalMaatId > 0 && variant.size_label) {
    await ensureSizeTermExists(globalMaatId, variant.size_label, wooConfig);
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
  
  // For variations, use global attribute ID when available — NEVER use id: 0
  // id: 0 causes WooCommerce to show ALL sizes for every variation
  const attrRef: any = (globalMaatId > 0)
    ? { id: globalMaatId }
    : (currentSizeAttr?.id && currentSizeAttr.id > 0)
      ? { id: currentSizeAttr.id }
      : { name: 'pa_maat' };
  updateData.attributes = [{
    ...attrRef,
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
