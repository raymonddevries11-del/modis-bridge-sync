import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooProduct {
  id: number;
  sku: string;
  type: string;
  stock_quantity: number;
}

interface WooVariation {
  id: number;
  sku: string;
  stock_quantity: number;
}

interface CacheData {
  products: { sku: string; id: number; type: string; stock_quantity: number }[];
  variations: { sku: string; id: number; parent_id: number; stock_quantity: number }[];
  cached_at: string;
  product_count: number;
  variation_count: number;
  complete: boolean;
  last_variable_index?: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    const { tenantId, continueFrom } = await req.json();

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    console.log(`Starting WooCommerce cache build for tenant ${tenantId}, continueFrom: ${continueFrom ?? 'start'}`);

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (configError || !tenantConfig) {
      throw new Error(`Failed to get tenant config: ${configError?.message}`);
    }

    const cacheKey = `woo_cache_${tenantId}`;
    
    // Check for existing partial cache
    let existingCache: CacheData | null = null;
    if (continueFrom !== undefined) {
      const { data: configData } = await supabase
        .from('config')
        .select('value')
        .eq('key', cacheKey)
        .maybeSingle();
      
      if (configData?.value) {
        existingCache = configData.value as CacheData;
        console.log(`Continuing from existing cache: ${existingCache.product_count} products, ${existingCache.variation_count} variations`);
      }
    }

    let wooProducts: { sku: string; id: number; type: string; stock_quantity: number }[] = existingCache?.products ?? [];
    let wooVariations: { sku: string; id: number; parent_id: number; stock_quantity: number }[] = existingCache?.variations ?? [];
    
    // STEP 1: Fetch ALL WooCommerce products (only if starting fresh)
    if (!existingCache || continueFrom === undefined) {
      console.log('Fetching all WooCommerce products...');
      wooProducts = [];
      let page = 1;
      const perPage = 100;

      while (true) {
        const url = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products`);
        url.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
        url.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);
        url.searchParams.append('per_page', String(perPage));
        url.searchParams.append('page', String(page));

        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error(`Failed to fetch WooCommerce products page ${page}: ${response.status}`);
        }

        const products: WooProduct[] = await response.json();
        console.log(`Products page ${page}: ${products.length} items`);

        for (const product of products) {
          if (product.sku) {
            wooProducts.push({
              sku: product.sku,
              id: product.id,
              type: product.type,
              stock_quantity: product.stock_quantity || 0,
            });
          }
        }

        if (products.length < perPage) break;
        page++;
      }

      console.log(`Total products fetched: ${wooProducts.length}`);
    }

    // STEP 2: Fetch variations for variable products WITH PAGINATION
    const variableProducts = wooProducts.filter(p => p.type === 'variable');
    const startIndex = continueFrom ?? 0;
    const BATCH_SIZE = 10;
    const MAX_PRODUCTS_PER_RUN = 500; // Process max 500 variable products per run
    const endIndex = Math.min(startIndex + MAX_PRODUCTS_PER_RUN, variableProducts.length);
    
    console.log(`Fetching variations for variable products ${startIndex}-${endIndex} of ${variableProducts.length}...`);

    for (let i = startIndex; i < endIndex; i += BATCH_SIZE) {
      const batch = variableProducts.slice(i, Math.min(i + BATCH_SIZE, endIndex));
      
      await Promise.all(batch.map(async (product) => {
        try {
          let varPage = 1;
          while (true) {
            const varUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/${product.id}/variations`);
            varUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
            varUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);
            varUrl.searchParams.append('per_page', '100');
            varUrl.searchParams.append('page', String(varPage));

            const varResponse = await fetch(varUrl.toString());
            if (varResponse.ok) {
              const variations: WooVariation[] = await varResponse.json();
              for (const variation of variations) {
                if (variation.sku) {
                  // Avoid duplicates
                  const exists = wooVariations.some(v => v.id === variation.id);
                  if (!exists) {
                    wooVariations.push({
                      sku: variation.sku,
                      id: variation.id,
                      parent_id: product.id,
                      stock_quantity: variation.stock_quantity || 0,
                    });
                  }
                }
              }
              if (variations.length < 100) break;
              varPage++;
            } else {
              break;
            }
          }
        } catch (e) {
          console.error(`Failed to fetch variations for product ${product.id}`);
        }
      }));

      const progress = Math.min(i + BATCH_SIZE, endIndex);
      console.log(`Variations progress: ${progress}/${variableProducts.length}`);
    }

    console.log(`Total variations fetched: ${wooVariations.length}`);

    // Determine if complete
    const isComplete = endIndex >= variableProducts.length;
    const nextOffset = isComplete ? null : endIndex;

    // STEP 3: Store cache in config table
    const cacheData: CacheData = {
      products: wooProducts,
      variations: wooVariations,
      cached_at: new Date().toISOString(),
      product_count: wooProducts.length,
      variation_count: wooVariations.length,
      complete: isComplete,
      last_variable_index: endIndex,
    };

    const { error: upsertError } = await supabase
      .from('config')
      .upsert({
        key: cacheKey,
        value: cacheData,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

    if (upsertError) {
      throw new Error(`Failed to save cache: ${upsertError.message}`);
    }

    console.log(`Cache saved: ${wooProducts.length} products, ${wooVariations.length} variations, complete: ${isComplete}`);

    // Log to changelog only when complete
    if (isComplete) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_CACHE_BUILT',
        description: `WooCommerce cache opgebouwd: ${wooProducts.length} producten, ${wooVariations.length} variaties`,
        metadata: { product_count: wooProducts.length, variation_count: wooVariations.length },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        products: wooProducts.length,
        variations: wooVariations.length,
        cached_at: cacheData.cached_at,
        complete: isComplete,
        nextOffset,
        hasMore: !isComplete,
        processedRange: `${startIndex}-${endIndex} of ${variableProducts.length} variable products`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in cache-woo-products:', errorMessage);
    
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
