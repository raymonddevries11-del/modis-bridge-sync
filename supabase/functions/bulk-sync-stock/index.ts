import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface StockUpdate {
  id: number;
  stock_quantity: number;
  stock_status: string;
  manage_stock: boolean;
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

    console.log(`Starting bulk stock sync for tenant ${tenantId}, dryRun=${dryRun}, productIds=${productIds?.length || 'all'}`);

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Failed to get tenant config: ${configError?.message}`);
    }

    // Build product query - if no productIds specified, get all
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
    } else {
      query = query.limit(100); // Limit for safety when no productIds specified
    }

    const { data: products, error: productsError } = await query;

    if (productsError) {
      throw new Error(`Failed to fetch products: ${productsError.message}`);
    }

    console.log(`Found ${products?.length || 0} products to sync`);

    if (!products || products.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No products to sync', updated: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const stats = {
      productsLookedUp: 0,
      productsFound: 0,
      simpleProductsUpdated: 0,
      variationsUpdated: 0,
      errors: 0,
    };
    const errorDetails: string[] = [];
    const updates: { sku: string; oldStock: number; newStock: number }[] = [];

    // Process each product - look up by SKU in WooCommerce
    for (const product of products) {
      try {
        stats.productsLookedUp++;
        
        // Look up product by SKU in WooCommerce
        const searchUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products`);
        searchUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
        searchUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);
        searchUrl.searchParams.append('sku', product.sku);

        const searchResponse = await fetch(searchUrl.toString());
        if (!searchResponse.ok) {
          errorDetails.push(`Failed to search for SKU ${product.sku}: ${searchResponse.status}`);
          stats.errors++;
          continue;
        }

        const wooProducts = await searchResponse.json();
        if (!wooProducts || wooProducts.length === 0) {
          console.log(`Product ${product.sku} not found in WooCommerce`);
          continue;
        }

        const wooProduct = wooProducts[0];
        stats.productsFound++;

        // Handle simple products (accessories without variants)
        if (wooProduct.type === 'simple') {
          // Calculate total stock from variants or default to 0
          let totalStock = 0;
          if (product.variants && product.variants.length > 0) {
            for (const variant of product.variants) {
              const stockTotals = variant.stock_totals as { qty: number }[] | null;
              totalStock += stockTotals?.[0]?.qty ?? 0;
            }
          }

          const oldStock = wooProduct.stock_quantity || 0;
          
          if (!dryRun && oldStock !== totalStock) {
            const updateUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/${wooProduct.id}`);
            updateUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
            updateUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);

            const updateResponse = await fetch(updateUrl.toString(), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                stock_quantity: totalStock,
                stock_status: totalStock > 0 ? 'instock' : 'outofstock',
                manage_stock: true,
              }),
            });

            if (updateResponse.ok) {
              stats.simpleProductsUpdated++;
              updates.push({ sku: product.sku, oldStock, newStock: totalStock });
            } else {
              errorDetails.push(`Failed to update ${product.sku}: ${await updateResponse.text()}`);
              stats.errors++;
            }
          } else if (dryRun && oldStock !== totalStock) {
            updates.push({ sku: product.sku, oldStock, newStock: totalStock });
          }
        }
        // Handle variable products
        else if (wooProduct.type === 'variable' && product.variants && product.variants.length > 0) {
          // Fetch variations
          const varUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/${wooProduct.id}/variations`);
          varUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
          varUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);
          varUrl.searchParams.append('per_page', '100');

          const varResponse = await fetch(varUrl.toString());
          if (!varResponse.ok) {
            errorDetails.push(`Failed to fetch variations for ${product.sku}`);
            stats.errors++;
            continue;
          }

          const wooVariations = await varResponse.json();
          
          // Build batch update for variations
          const variationUpdates: StockUpdate[] = [];

          for (const variant of product.variants) {
            const stockTotals = variant.stock_totals as { qty: number }[] | null;
            const newStock = stockTotals?.[0]?.qty ?? 0;
            const variantSku = `${product.sku}-${variant.maat_id}`;

            // Find matching WooCommerce variation by SKU
            const wooVariation = wooVariations.find((v: any) => v.sku === variantSku);
            
            if (wooVariation) {
              const oldStock = wooVariation.stock_quantity || 0;
              if (oldStock !== newStock) {
                variationUpdates.push({
                  id: wooVariation.id,
                  stock_quantity: newStock,
                  stock_status: newStock > 0 ? 'instock' : 'outofstock',
                  manage_stock: true,
                });
                updates.push({ sku: variantSku, oldStock, newStock });
              }
            }
          }

          // Execute batch update for variations
          if (!dryRun && variationUpdates.length > 0) {
            const batchUrl = new URL(`${tenantConfig.woocommerce_url}/wp-json/wc/v3/products/${wooProduct.id}/variations/batch`);
            batchUrl.searchParams.append('consumer_key', tenantConfig.woocommerce_consumer_key);
            batchUrl.searchParams.append('consumer_secret', tenantConfig.woocommerce_consumer_secret);

            const batchResponse = await fetch(batchUrl.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ update: variationUpdates }),
            });

            if (batchResponse.ok) {
              const result = await batchResponse.json();
              stats.variationsUpdated += result.update?.length || 0;
              console.log(`Updated ${result.update?.length || 0} variations for ${product.sku}`);
            } else {
              errorDetails.push(`Batch update failed for ${product.sku}: ${await batchResponse.text()}`);
              stats.errors++;
            }
          } else if (dryRun) {
            stats.variationsUpdated += variationUpdates.length;
          }
        }

        // Small delay between products to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (productError) {
        const errorMsg = productError instanceof Error ? productError.message : String(productError);
        errorDetails.push(`Error processing ${product.sku}: ${errorMsg}`);
        stats.errors++;
      }
    }

    // Log to changelog if not dry run
    if (!dryRun) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'BULK_STOCK_SYNC',
        description: `Bulk stock sync: ${stats.simpleProductsUpdated} simple products, ${stats.variationsUpdated} variations bijgewerkt`,
        metadata: { stats, updates: updates.slice(0, 50) },
      });
    }

    console.log(`Bulk sync complete: ${JSON.stringify(stats)}`);

    return new Response(
      JSON.stringify({
        success: true,
        dryRun,
        stats,
        updates: updates.slice(0, 100),
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
