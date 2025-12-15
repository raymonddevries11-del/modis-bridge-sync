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

interface ResetProgress {
  currentPage: number;
  totalPages: number;
  totalVariationsUpdated: number;
  totalErrors: number;
  pagesProcessed: number;
}

const BATCH_SIZE = 50; // Products per API call
const MAX_PAGES_PER_EXECUTION = 5; // Process max 5 pages per function call to avoid timeout

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

async function processProductBatch(
  product: any,
  wooConfig: WooCommerceConfig
): Promise<{ updated: number; error: boolean }> {
  try {
    const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${product.id}/variations`);
    variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
    variationsUrl.searchParams.append('per_page', '100');

    const variationsResponse = await fetchWithRetry(variationsUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!variationsResponse.ok) {
      console.error(`Failed to fetch variations for product ${product.id}`);
      return { updated: 0, error: true };
    }

    const variations = await variationsResponse.json();

    if (!variations || variations.length === 0) {
      return { updated: 0, error: false };
    }

    const variationsWithStock = variations.filter((v: any) => 
      (v.stock_quantity && v.stock_quantity > 0) || v.stock_status === 'instock'
    );

    if (variationsWithStock.length === 0) {
      return { updated: 0, error: false };
    }

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
      console.log(`Product ${product.sku || product.id}: ${updatedCount} variations set to 0`);
      return { updated: updatedCount, error: false };
    } else {
      console.error(`Failed to update product ${product.id}`);
      return { updated: 0, error: true };
    }
  } catch (error: any) {
    console.error(`Error processing product ${product.id}:`, error.message);
    return { updated: 0, error: true };
  }
}

async function processPages(
  wooConfig: WooCommerceConfig,
  startPage: number,
  maxPagesToProcess: number
): Promise<{ 
  variationsUpdated: number; 
  errors: number; 
  pagesProcessed: number;
  currentPage: number;
  totalPages: number;
  complete: boolean;
}> {
  let currentPage = startPage;
  let variationsUpdated = 0;
  let errors = 0;
  let pagesProcessed = 0;
  let totalPages = 1;

  for (let i = 0; i < maxPagesToProcess; i++) {
    console.log(`Processing page ${currentPage}...`);

    const productsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
    productsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    productsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
    productsUrl.searchParams.append('per_page', BATCH_SIZE.toString());
    productsUrl.searchParams.append('page', currentPage.toString());
    productsUrl.searchParams.append('type', 'variable');
    productsUrl.searchParams.append('status', 'any');

    const response = await fetchWithRetry(productsUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch products page ${currentPage}: ${response.status} - ${errorText}`);
    }

    const products = await response.json();
    totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1');
    const totalProducts = parseInt(response.headers.get('X-WP-Total') || '0');

    console.log(`Page ${currentPage}/${totalPages}: ${products.length} products (total: ${totalProducts})`);

    if (!products || products.length === 0) {
      break;
    }

    for (const product of products) {
      const result = await processProductBatch(product, wooConfig);
      variationsUpdated += result.updated;
      if (result.error) errors++;
      
      // Small delay between products to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    pagesProcessed++;
    console.log(`Page ${currentPage} complete: ${variationsUpdated} total variations updated so far`);

    if (currentPage >= totalPages) {
      return { variationsUpdated, errors, pagesProcessed, currentPage, totalPages, complete: true };
    }

    currentPage++;
    
    // Delay between pages
    await new Promise(r => setTimeout(r, 500));
  }

  return { 
    variationsUpdated, 
    errors, 
    pagesProcessed, 
    currentPage, 
    totalPages,
    complete: currentPage > totalPages 
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
    const body = await req.json();
    const { tenantId, jobId } = body;

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    // Check for existing job or create new one
    let progress: ResetProgress;
    let currentJobId = jobId;

    if (jobId) {
      // Resume existing job
      const { data: job, error: jobError } = await supabase
        .from('jobs')
        .select('*')
        .eq('id', jobId)
        .single();

      if (jobError || !job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      progress = job.payload as ResetProgress;
      console.log(`Resuming stock reset job ${jobId} from page ${progress.currentPage}`);
    } else {
      // Create new job
      progress = {
        currentPage: 1,
        totalPages: 0,
        totalVariationsUpdated: 0,
        totalErrors: 0,
        pagesProcessed: 0,
      };

      const { data: newJob, error: createError } = await supabase
        .from('jobs')
        .insert({
          type: 'WOO_STOCK_RESET',
          state: 'processing',
          tenant_id: tenantId,
          payload: progress,
        })
        .select()
        .single();

      if (createError || !newJob) {
        throw new Error(`Failed to create job: ${createError?.message}`);
      }

      currentJobId = newJob.id;
      console.log(`Created new stock reset job ${currentJobId}`);
    }

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

    // Process a batch of pages
    const result = await processPages(wooConfig, progress.currentPage, MAX_PAGES_PER_EXECUTION);

    // Update progress
    progress.currentPage = result.currentPage + 1;
    progress.totalPages = result.totalPages;
    progress.totalVariationsUpdated += result.variationsUpdated;
    progress.totalErrors += result.errors;
    progress.pagesProcessed += result.pagesProcessed;

    if (result.complete) {
      // Job complete
      await supabase
        .from('jobs')
        .update({
          state: 'done',
          payload: progress,
          updated_at: new Date().toISOString(),
        })
        .eq('id', currentJobId);

      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_STOCK_RESET_COMPLETE',
        description: `WooCommerce stock reset voltooid: ${progress.totalVariationsUpdated} variaties op 0 gezet`,
        metadata: {
          jobId: currentJobId,
          totalVariationsUpdated: progress.totalVariationsUpdated,
          totalErrors: progress.totalErrors,
          pagesProcessed: progress.pagesProcessed,
          completedAt: new Date().toISOString(),
        },
      });

      console.log(`Stock reset complete: ${progress.totalVariationsUpdated} variations updated, ${progress.totalErrors} errors`);

      return new Response(
        JSON.stringify({
          success: true,
          complete: true,
          jobId: currentJobId,
          progress,
          message: `Stock reset complete: ${progress.totalVariationsUpdated} variations set to 0`,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      // Job still in progress - update job and return continuation info
      await supabase
        .from('jobs')
        .update({
          state: 'ready', // Set to ready so scheduler can pick it up again
          payload: progress,
          updated_at: new Date().toISOString(),
        })
        .eq('id', currentJobId);

      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_STOCK_RESET_PROGRESS',
        description: `Stock reset voortgang: pagina ${progress.currentPage - 1}/${result.totalPages}, ${progress.totalVariationsUpdated} variaties op 0 gezet`,
        metadata: {
          jobId: currentJobId,
          currentPage: progress.currentPage,
          totalPages: result.totalPages,
          variationsUpdatedThisBatch: result.variationsUpdated,
          totalVariationsUpdated: progress.totalVariationsUpdated,
        },
      });

      console.log(`Stock reset progress: page ${progress.currentPage - 1}/${result.totalPages}, ${progress.totalVariationsUpdated} total updated`);

      return new Response(
        JSON.stringify({
          success: true,
          complete: false,
          jobId: currentJobId,
          progress,
          nextPage: progress.currentPage,
          message: `Processed pages ${progress.currentPage - result.pagesProcessed} to ${progress.currentPage - 1} of ${result.totalPages}. Continue with jobId to resume.`,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Stock reset error:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
