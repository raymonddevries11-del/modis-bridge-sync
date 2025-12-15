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

// Helper function to normalize size strings for comparison
const normalizeSize = (size: string): string => {
  return size?.toLowerCase().trim().replace(/\s+/g, ' ') || '';
};

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // If rate limited, wait and retry
      if (response.status === 429) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Rate limited, waiting ${waitTime}ms before retry ${attempt}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Fetch attempt ${attempt} failed:`, lastError.message);
      
      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError || new Error('All fetch attempts failed');
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
    const body = await req.json().catch(() => ({}));
    const { tenantId, dryRun = false, limit = 20, offset = 0, productSku } = body;

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    console.log(`Starting WooCommerce variation SKU fix for tenant ${tenantId}, dryRun=${dryRun}, limit=${limit}, offset=${offset}, productSku=${productSku || 'all'}`);

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Tenant config not found: ${configError?.message}`);
    }

    const wooConfig: WooCommerceConfig = {
      url: tenantConfig.woocommerce_url,
      consumerKey: tenantConfig.woocommerce_consumer_key,
      consumerSecret: tenantConfig.woocommerce_consumer_secret,
    };

    // Fetch products with variants that have maat_id
    let query = supabase
      .from('products')
      .select(`
        id,
        sku,
        title,
        variants (
          id,
          maat_id,
          size_label
        )
      `)
      .eq('tenant_id', tenantId);
    
    // Filter by specific product SKU if provided
    if (productSku) {
      query = query.eq('sku', productSku);
    }
    
    const { data: products, error: productsError } = await query.range(offset, offset + limit - 1);

    if (productsError) {
      throw new Error(`Failed to fetch products: ${productsError.message}`);
    }

    if (!products || products.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No products found', stats: { updated: 0, skipped: 0, errors: 0 } }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing ${products.length} products`);

    const stats = {
      updated: 0,
      skipped: 0,
      errors: 0,
      alreadyCorrect: 0,
    };
    const errorDetails: string[] = [];
    const updatedSkus: { old: string; new: string; productSku: string; size: string }[] = [];

    // Process each product
    for (const product of products) {
      try {
        const productSku = product.sku;
        const variants = product.variants || [];

        if (variants.length === 0) {
          console.log(`Product ${productSku} has no variants, skipping`);
          continue;
        }

        // Search for WooCommerce product by SKU
        const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
        searchUrl.searchParams.append('sku', productSku);
        searchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
        searchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

        const searchResponse = await fetchWithRetry(searchUrl.toString(), {
          headers: { 'Content-Type': 'application/json' },
        });

        if (!searchResponse.ok) {
          const errorText = await searchResponse.text();
          console.error(`Failed to search product ${productSku}: ${errorText}`);
          stats.errors++;
          errorDetails.push(`Search failed for ${productSku}: ${searchResponse.status}`);
          continue;
        }

        const wooProducts = await searchResponse.json();
        if (!wooProducts || wooProducts.length === 0) {
          console.log(`Product ${productSku} not found in WooCommerce, skipping`);
          stats.skipped++;
          continue;
        }

        const wooProductId = wooProducts[0].id;

        // Fetch all variations for this product
        const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
        variationsUrl.searchParams.append('per_page', '100');
        variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
        variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

        const variationsResponse = await fetchWithRetry(variationsUrl.toString(), {
          headers: { 'Content-Type': 'application/json' },
        });

        if (!variationsResponse.ok) {
          console.error(`Failed to fetch variations for product ${productSku}`);
          stats.errors++;
          continue;
        }

        const wooVariations = await variationsResponse.json();
        console.log(`Product ${productSku}: found ${wooVariations.length} WooCommerce variations, ${variants.length} database variants`);

        // Match each database variant to WooCommerce variation and update SKU
        for (const dbVariant of variants) {
          if (!dbVariant.maat_id || dbVariant.maat_id.length !== 6) {
            console.log(`Variant ${dbVariant.size_label} has invalid maat_id: ${dbVariant.maat_id}, skipping`);
            stats.skipped++;
            continue;
          }

          const expectedSku = `${productSku}-${dbVariant.maat_id}`;

          // Find matching WooCommerce variation by size_label in attributes OR current SKU format
          let matchingWooVariation = null;

          for (const wooVar of wooVariations) {
            // Check by SKU suffix (current format: productSku-size_label)
            const currentSku = wooVar.sku || '';
            
            // Already has correct SKU?
            if (currentSku === expectedSku) {
              stats.alreadyCorrect++;
              matchingWooVariation = null; // Don't need to update
              break;
            }

            // Match by size_label in SKU (current wrong format)
            if (currentSku.endsWith(`-${dbVariant.size_label}`)) {
              matchingWooVariation = wooVar;
              break;
            }

            // Match by Maat attribute
            const sizeAttr = wooVar.attributes?.find((attr: any) =>
              attr.name?.toLowerCase() === 'maat' ||
              attr.name?.toLowerCase() === 'size' ||
              attr.name?.toLowerCase() === 'pa_maat'
            );

            if (sizeAttr?.option && normalizeSize(sizeAttr.option) === normalizeSize(dbVariant.size_label)) {
              matchingWooVariation = wooVar;
              break;
            }
          }

          if (!matchingWooVariation) {
            // Either already correct or not found
            continue;
          }

          const oldSku = matchingWooVariation.sku || '';
          
          if (dryRun) {
            console.log(`[DRY RUN] Would update variation ${matchingWooVariation.id}: "${oldSku}" → "${expectedSku}"`);
            updatedSkus.push({ old: oldSku, new: expectedSku, productSku, size: dbVariant.size_label });
            stats.updated++;
          } else {
            // Update the variation SKU in WooCommerce
            const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/${matchingWooVariation.id}`);
            updateUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
            updateUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

            const updateResponse = await fetchWithRetry(updateUrl.toString(), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sku: expectedSku }),
            });

            if (updateResponse.ok) {
              console.log(`Updated variation ${matchingWooVariation.id}: "${oldSku}" → "${expectedSku}"`);
              updatedSkus.push({ old: oldSku, new: expectedSku, productSku, size: dbVariant.size_label });
              stats.updated++;
            } else {
              const errorText = await updateResponse.text();
              console.error(`Failed to update variation ${matchingWooVariation.id}: ${errorText}`);
              stats.errors++;
              errorDetails.push(`Update failed for ${productSku}-${dbVariant.size_label}: ${updateResponse.status}`);
            }

            // Rate limit: wait between updates
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }

        // Wait between products to avoid overwhelming WooCommerce
        await new Promise(resolve => setTimeout(resolve, 300));

      } catch (productError) {
        const errorMsg = productError instanceof Error ? productError.message : String(productError);
        console.error(`Error processing product ${product.sku}:`, errorMsg);
        stats.errors++;
        errorDetails.push(`${product.sku}: ${errorMsg}`);
      }
    }

    // Log to changelog
    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_SKU_FIX',
      description: `WooCommerce variation SKUs gecorrigeerd: ${stats.updated} updated, ${stats.alreadyCorrect} already correct, ${stats.skipped} skipped, ${stats.errors} errors${dryRun ? ' (DRY RUN)' : ''}`,
      metadata: {
        stats,
        dryRun,
        limit,
        offset,
        productsProcessed: products.length,
        sampleUpdates: updatedSkus.slice(0, 20),
        errors: errorDetails.slice(0, 10)
      }
    });

    return new Response(
      JSON.stringify({
        success: true,
        dryRun,
        stats,
        offset,
        nextOffset: offset + limit,
        productsProcessed: products.length,
        sampleUpdates: updatedSkus.slice(0, 50),
        errors: errorDetails.slice(0, 20)
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in fix-woo-variation-skus:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
