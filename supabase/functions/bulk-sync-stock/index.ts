import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CachedProduct {
  sku: string;
  id: number;
  type: string;
  stock_quantity: number;
}

interface CachedVariation {
  sku: string;
  id: number;
  parent_id: number;
  stock_quantity: number;
}

interface WooCache {
  products: CachedProduct[];
  variations: CachedVariation[];
  cached_at: string;
  product_count: number;
  variation_count: number;
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
    const { tenantId, offset = 0, limit = 500, dryRun = false } = await req.json();

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    console.log(`Bulk stock sync - tenant: ${tenantId}, offset: ${offset}, limit: ${limit}, dryRun: ${dryRun}`);

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (configError || !tenantConfig) {
      throw new Error(`Failed to get tenant config: ${configError?.message}`);
    }

    // STEP 1: Load WooCommerce cache
    const cacheKey = `woo_cache_${tenantId}`;
    const { data: cacheRow, error: cacheError } = await supabase
      .from('config')
      .select('value')
      .eq('key', cacheKey)
      .maybeSingle();

    if (cacheError || !cacheRow) {
      throw new Error('WooCommerce cache not found. Run cache-woo-products first.');
    }

    const wooCache = cacheRow.value as WooCache;
    console.log(`Loaded cache: ${wooCache.product_count} products, ${wooCache.variation_count} variations (cached at ${wooCache.cached_at})`);

    // Build lookup maps from cache
    const wooProductMap = new Map<string, CachedProduct>();
    const wooVariationMap = new Map<string, CachedVariation>();

    for (const product of wooCache.products) {
      wooProductMap.set(product.sku, product);
    }
    for (const variation of wooCache.variations) {
      wooVariationMap.set(variation.sku, variation);
    }

    // STEP 2: Fetch Supabase products with pagination
    const { data: products, error: productsError, count } = await supabase
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
      `, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .range(offset, offset + limit - 1)
      .order('created_at', { ascending: true });

    if (productsError) {
      throw new Error(`Failed to fetch products: ${productsError.message}`);
    }

    const totalProducts = count || 0;
    const hasMore = offset + limit < totalProducts;
    const nextOffset = hasMore ? offset + limit : null;

    console.log(`Fetched ${products?.length || 0} Supabase products (offset: ${offset}, total: ${totalProducts})`);

    if (!products || products.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No products to process',
          offset,
          nextOffset: null,
          hasMore: false,
          totalProducts,
          stats: { simpleProductsUpdated: 0, variationsUpdated: 0, errors: 0, notInWoo: 0 },
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // STEP 3: Build batch updates by comparing with cache
    const simpleProductUpdates: { id: number; stock_quantity: number; stock_status: string; manage_stock: boolean }[] = [];
    const variationUpdatesByParent = new Map<number, { id: number; stock_quantity: number; stock_status: string; manage_stock: boolean }[]>();
    const updateLog: { sku: string; oldStock: number; newStock: number }[] = [];
    let notInWoo = 0;

    for (const product of products) {
      const wooProduct = wooProductMap.get(product.sku);
      if (!wooProduct) {
        notInWoo++;
        continue;
      }

      if (wooProduct.type === 'simple') {
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

    console.log(`Updates needed: ${simpleProductUpdates.length} simple, ${variationUpdatesByParent.size} parents with variations, ${notInWoo} not in WooCommerce`);

    const stats = {
      simpleProductsUpdated: 0,
      variationsUpdated: 0,
      errors: 0,
      notInWoo,
    };
    const errorDetails: string[] = [];

    if (!dryRun) {
      // STEP 4: Execute batch update for simple products
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
              console.log(`Simple batch: updated ${result.update?.length || 0}`);
            } else {
              const errorText = await batchResponse.text();
              errorDetails.push(`Simple batch failed: ${errorText.substring(0, 200)}`);
              stats.errors++;
            }
          } catch (e) {
            errorDetails.push(`Simple batch error: ${e instanceof Error ? e.message : String(e)}`);
            stats.errors++;
          }
        }
      }

      // STEP 5: Execute batch updates for variations
      const parentIds = Array.from(variationUpdatesByParent.keys());
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
        description: `Bulk stock sync batch (offset ${offset}): ${stats.simpleProductsUpdated} simple, ${stats.variationsUpdated} variations`,
        metadata: { offset, limit, stats, updates: updateLog.slice(0, 20) },
      });
    } else {
      stats.simpleProductsUpdated = simpleProductUpdates.length;
      stats.variationsUpdated = Array.from(variationUpdatesByParent.values()).reduce((sum, arr) => sum + arr.length, 0);
    }

    console.log(`Batch complete: ${JSON.stringify(stats)}`);

    return new Response(
      JSON.stringify({
        success: true,
        dryRun,
        offset,
        nextOffset,
        hasMore,
        totalProducts,
        processedThisBatch: products.length,
        cacheAge: wooCache.cached_at,
        stats,
        pendingUpdates: updateLog.length,
        updates: updateLog.slice(0, 50),
        errors: errorDetails.slice(0, 10),
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
