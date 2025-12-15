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
  parent_id: number;
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
    const { tenantId, productIds, dryRun = false } = await req.json();

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    console.log(`Starting optimized bulk stock sync for tenant ${tenantId}, dryRun=${dryRun}`);

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Failed to get tenant config: ${configError?.message}`);
    }

    // STEP 1: Fetch ALL WooCommerce products with pagination (build SKU map)
    console.log('Fetching all WooCommerce products...');
    const wooProductMap = new Map<string, WooProduct>();
    const wooVariationMap = new Map<string, WooVariation>();
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
      console.log(`Fetched page ${page}: ${products.length} products`);

      for (const product of products) {
        if (product.sku) {
          wooProductMap.set(product.sku, product);
        }
      }

      if (products.length < perPage) break;
      page++;
    }

    console.log(`Total WooCommerce products indexed: ${wooProductMap.size}`);

    // STEP 2: Fetch ALL WooCommerce variations (for variable products)
    const variableProducts = Array.from(wooProductMap.values()).filter(p => p.type === 'variable');
    console.log(`Fetching variations for ${variableProducts.length} variable products...`);

    // Batch fetch variations - process in chunks to avoid timeouts
    const VARIATION_BATCH_SIZE = 10;
    for (let i = 0; i < variableProducts.length; i += VARIATION_BATCH_SIZE) {
      const batch = variableProducts.slice(i, i + VARIATION_BATCH_SIZE);
      
      await Promise.all(batch.map(async (product) => {
        try {
          const varUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/${product.id}/variations`);
          varUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
          varUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);
          varUrl.searchParams.append('per_page', '100');

          const varResponse = await fetch(varUrl.toString());
          if (varResponse.ok) {
            const variations: WooVariation[] = await varResponse.json();
            for (const variation of variations) {
              if (variation.sku) {
                wooVariationMap.set(variation.sku, { ...variation, parent_id: product.id });
              }
            }
          }
        } catch (e) {
          console.error(`Failed to fetch variations for product ${product.id}`);
        }
      }));
      
      console.log(`Fetched variations batch ${Math.floor(i / VARIATION_BATCH_SIZE) + 1}/${Math.ceil(variableProducts.length / VARIATION_BATCH_SIZE)}`);
    }

    console.log(`Total WooCommerce variations indexed: ${wooVariationMap.size}`);

    // STEP 3: Fetch Supabase products with stock
    let query = supabase
      .from('products')
      .select(`
        id,
        sku,
        title,
        variants (
          id,
          maat_id,
          size_label,
          stock_totals (qty)
        )
      `)
      .eq('tenant_id', tenantId);

    if (productIds && productIds.length > 0) {
      query = query.in('id', productIds);
    }

    const { data: products, error: productsError } = await query;

    if (productsError) {
      throw new Error(`Failed to fetch products: ${productsError.message}`);
    }

    console.log(`Found ${products?.length || 0} Supabase products to sync`);

    // STEP 4: Build batch updates
    const simpleProductUpdates: { id: number; stock_quantity: number; stock_status: string; manage_stock: boolean }[] = [];
    const variationUpdatesByParent = new Map<number, { id: number; stock_quantity: number; stock_status: string; manage_stock: boolean }[]>();
    const updateLog: { sku: string; oldStock: number; newStock: number }[] = [];

    for (const product of products || []) {
      const wooProduct = wooProductMap.get(product.sku);
      if (!wooProduct) continue;

      if (wooProduct.type === 'simple') {
        // Calculate total stock
        let totalStock = 0;
        for (const variant of product.variants || []) {
          const stockTotals = variant.stock_totals as { qty: number }[] | null;
          totalStock += stockTotals?.[0]?.qty ?? 0;
        }

        const oldStock = wooProduct.stock_quantity || 0;
        if (oldStock !== totalStock) {
          simpleProductUpdates.push({
            id: wooProduct.id,
            stock_quantity: totalStock,
            stock_status: totalStock > 0 ? 'instock' : 'outofstock',
            manage_stock: true,
          });
          updateLog.push({ sku: product.sku, oldStock, newStock: totalStock });
        }
      } else if (wooProduct.type === 'variable') {
        for (const variant of product.variants || []) {
          const variantSku = `${product.sku}-${variant.maat_id}`;
          const wooVariation = wooVariationMap.get(variantSku);
          
          if (wooVariation) {
            const stockTotals = variant.stock_totals as { qty: number }[] | null;
            const newStock = stockTotals?.[0]?.qty ?? 0;
            const oldStock = wooVariation.stock_quantity || 0;

            if (oldStock !== newStock) {
              if (!variationUpdatesByParent.has(wooVariation.parent_id)) {
                variationUpdatesByParent.set(wooVariation.parent_id, []);
              }
              variationUpdatesByParent.get(wooVariation.parent_id)!.push({
                id: wooVariation.id,
                stock_quantity: newStock,
                stock_status: newStock > 0 ? 'instock' : 'outofstock',
                manage_stock: true,
              });
              updateLog.push({ sku: variantSku, oldStock, newStock });
            }
          }
        }
      }
    }

    console.log(`Prepared ${simpleProductUpdates.length} simple product updates, ${variationUpdatesByParent.size} parent products with variation updates`);

    const stats = {
      simpleProductsUpdated: 0,
      variationsUpdated: 0,
      errors: 0,
    };
    const errorDetails: string[] = [];

    if (!dryRun) {
      // STEP 5: Execute batch update for simple products (100 per batch)
      if (simpleProductUpdates.length > 0) {
        const BATCH_SIZE = 100;
        for (let i = 0; i < simpleProductUpdates.length; i += BATCH_SIZE) {
          const batch = simpleProductUpdates.slice(i, i + BATCH_SIZE);
          
          const batchUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/batch`);
          batchUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
          batchUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);

          try {
            const batchResponse = await fetch(batchUrl.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ update: batch }),
            });

            if (batchResponse.ok) {
              const result = await batchResponse.json();
              stats.simpleProductsUpdated += result.update?.length || 0;
              console.log(`Simple products batch ${Math.floor(i / BATCH_SIZE) + 1}: updated ${result.update?.length || 0}`);
            } else {
              const errorText = await batchResponse.text();
              errorDetails.push(`Simple products batch failed: ${errorText.substring(0, 200)}`);
              stats.errors++;
            }
          } catch (e) {
            errorDetails.push(`Simple products batch error: ${e instanceof Error ? e.message : String(e)}`);
            stats.errors++;
          }
        }
      }

      // STEP 6: Execute batch updates for variations (per parent product)
      const parentIds = Array.from(variationUpdatesByParent.keys());
      console.log(`Processing variation updates for ${parentIds.length} parent products...`);
      
      // Process in parallel batches of 5 parent products
      const PARALLEL_BATCH = 5;
      for (let i = 0; i < parentIds.length; i += PARALLEL_BATCH) {
        const batchParentIds = parentIds.slice(i, i + PARALLEL_BATCH);
        
        await Promise.all(batchParentIds.map(async (parentId) => {
          const updates = variationUpdatesByParent.get(parentId)!;
          
          const batchUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/${parentId}/variations/batch`);
          batchUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
          batchUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);

          try {
            const batchResponse = await fetch(batchUrl.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ update: updates }),
            });

            if (batchResponse.ok) {
              const result = await batchResponse.json();
              stats.variationsUpdated += result.update?.length || 0;
            } else {
              stats.errors++;
            }
          } catch (e) {
            stats.errors++;
          }
        }));
        
        console.log(`Variation batch ${Math.floor(i / PARALLEL_BATCH) + 1}/${Math.ceil(parentIds.length / PARALLEL_BATCH)} complete`);
      }

      // Log to changelog
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'BULK_STOCK_SYNC',
        description: `Bulk stock sync: ${stats.simpleProductsUpdated} simple products, ${stats.variationsUpdated} variations bijgewerkt`,
        metadata: { stats, updates: updateLog.slice(0, 50) },
      });
    } else {
      stats.simpleProductsUpdated = simpleProductUpdates.length;
      stats.variationsUpdated = Array.from(variationUpdatesByParent.values()).reduce((sum, arr) => sum + arr.length, 0);
    }

    console.log(`Bulk sync complete: ${JSON.stringify(stats)}`);

    return new Response(
      JSON.stringify({
        success: true,
        dryRun,
        stats,
        pendingUpdates: updateLog.length,
        updates: updateLog.slice(0, 100),
        errors: errorDetails.slice(0, 20),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in bulk-sync-stock:', errorMessage);
    
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
