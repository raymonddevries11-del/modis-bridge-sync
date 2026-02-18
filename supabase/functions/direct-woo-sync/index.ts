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

function normalizeSize(size: string): string {
  return size.toLowerCase().replace(/\s+/g, '').trim();
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
        console.log(`Rate limited, waiting ${delay}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error as Error;
      console.error(`Fetch attempt ${attempt + 1} failed:`, error);
    }
  }
  throw lastError || new Error('All fetch attempts failed');
}

// Cache upsert helper
async function upsertWooCache(supabase: any, tenantId: string, wooProduct: any, productId: string, sku: string) {
  try {
    await supabase.from('woo_products').upsert({
      tenant_id: tenantId,
      woo_id: wooProduct.id,
      product_id: productId,
      sku,
      name: wooProduct.name || sku,
      slug: wooProduct.slug || '',
      status: wooProduct.status || 'publish',
      type: wooProduct.type || 'variable',
      last_pushed_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,woo_id' });
  } catch (e) {
    console.error('Cache upsert failed:', e);
  }
}

async function updateVariantStock(
  variant: any,
  product: any,
  wooConfig: WooCommerceConfig,
  supabase: any,
  tenantId: string
): Promise<{ success: boolean; message: string }> {
  const { sku: productSku } = product;
  const stockQty = variant.stock_totals?.qty || 0;

  const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
  searchUrl.searchParams.append('sku', productSku);
  searchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  searchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const searchResponse = await fetchWithRetry(searchUrl.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!searchResponse.ok) {
    return { success: false, message: `Product search failed: ${searchResponse.status}` };
  }

  const responseText = await searchResponse.text();
  let wooProducts;
  try { wooProducts = JSON.parse(responseText); } catch {
    return { success: false, message: 'Invalid JSON from WooCommerce' };
  }

  if (!wooProducts || wooProducts.length === 0) {
    return { success: false, message: `Product ${productSku} not found in WooCommerce` };
  }

  const wooProduct = wooProducts[0];
  const wooProductId = wooProduct.id;

  // Get variations
  const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
  variationsUrl.searchParams.append('per_page', '100');
  variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const variationsResponse = await fetchWithRetry(variationsUrl.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!variationsResponse.ok) {
    return { success: false, message: `Failed to get variations: ${variationsResponse.status}` };
  }

  const wooVariations = await variationsResponse.json();

  // Find matching variation
  const maatSuffix = variant.maat_id && variant.maat_id.includes('-') ? variant.maat_id.split('-').pop() : variant.maat_id;
  const expectedFullSku = `${productSku}-${maatSuffix}`;
  const legacyFullSku = `${productSku}-${variant.size_label}`;

  let matchingVariation = null;
  for (const wooVariation of wooVariations) {
    if (wooVariation.sku && normalizeSize(wooVariation.sku) === normalizeSize(expectedFullSku)) { matchingVariation = wooVariation; break; }
    if (wooVariation.sku && normalizeSize(wooVariation.sku) === normalizeSize(legacyFullSku)) { matchingVariation = wooVariation; break; }
    if (wooVariation.sku && wooVariation.sku.endsWith(variant.size_label)) { matchingVariation = wooVariation; break; }
    const sizeAttr = wooVariation.attributes?.find((attr: any) =>
      attr.name?.toLowerCase() === 'size' || attr.name?.toLowerCase() === 'maat' || attr.name?.toLowerCase() === 'pa_maat'
    );
    if (sizeAttr?.option && normalizeSize(variant.size_label) === normalizeSize(sizeAttr.option)) { matchingVariation = wooVariation; break; }
  }

  if (!matchingVariation) {
    return { success: false, message: `Variation ${variant.size_label} not found in WooCommerce` };
  }

  const updateData = {
    stock_quantity: stockQty,
    manage_stock: true,
    stock_status: stockQty > 0 ? 'instock' : 'outofstock',
  };

  const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/${matchingVariation.id}`);
  updateUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  updateUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const updateResponse = await fetchWithRetry(updateUrl.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData),
  });

  if (!updateResponse.ok) {
    return { success: false, message: `Update failed: ${updateResponse.status}` };
  }

  // Cache invalidation: upsert woo_products after successful stock update
  await upsertWooCache(supabase, tenantId, wooProduct, product.id, productSku);

  return {
    success: true,
    message: `Updated ${productSku}/${variant.size_label} stock: ${matchingVariation.stock_quantity} → ${stockQty}`
  };
}

async function updateProductPrice(
  product: any,
  regularPrice: number,
  listPrice: number | null,
  wooConfig: WooCommerceConfig,
  supabase: any,
  tenantId: string
): Promise<{ success: boolean; message: string }> {
  const { sku: productSku } = product;

  const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
  searchUrl.searchParams.append('sku', productSku);
  searchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
  searchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

  const searchResponse = await fetchWithRetry(searchUrl.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!searchResponse.ok) {
    return { success: false, message: `Product search failed: ${searchResponse.status}` };
  }

  const responseText = await searchResponse.text();
  let wooProducts;
  try { wooProducts = JSON.parse(responseText); } catch {
    return { success: false, message: 'Invalid JSON from WooCommerce' };
  }

  if (!wooProducts || wooProducts.length === 0) {
    return { success: false, message: `Product ${productSku} not found in WooCommerce` };
  }

  const wooProduct = wooProducts[0];
  const wooProductId = wooProduct.id;

  if (wooProduct.type === 'variable') {
    const variationsUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations`);
    variationsUrl.searchParams.append('per_page', '100');
    variationsUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    variationsUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

    const variationsResponse = await fetchWithRetry(variationsUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!variationsResponse.ok) {
      return { success: false, message: `Failed to get variations: ${variationsResponse.status}` };
    }

    const wooVariations = await variationsResponse.json();

    const batchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}/variations/batch`);
    batchUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    batchUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

    const updates = wooVariations.map((v: any) => ({
      id: v.id,
      regular_price: regularPrice.toString(),
      sale_price: listPrice ? listPrice.toString() : '',
    }));

    const batchResponse = await fetchWithRetry(batchUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update: updates }),
    });

    if (!batchResponse.ok) {
      return { success: false, message: `Batch price update failed: ${batchResponse.status}` };
    }

    // Cache invalidation after successful price update
    await upsertWooCache(supabase, tenantId, wooProduct, product.id, productSku);

    return {
      success: true,
      message: `Updated ${productSku} price on ${updates.length} variations: €${regularPrice}`
    };
  } else {
    const updateData: any = { regular_price: regularPrice.toString() };
    if (listPrice) { updateData.sale_price = listPrice.toString(); }

    const updateUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products/${wooProductId}`);
    updateUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    updateUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);

    const updateResponse = await fetchWithRetry(updateUrl.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateData),
    });

    if (!updateResponse.ok) {
      return { success: false, message: `Price update failed: ${updateResponse.status}` };
    }

    // Cache invalidation after successful price update
    await upsertWooCache(supabase, tenantId, wooProduct, product.id, productSku);

    return {
      success: true,
      message: `Updated ${productSku} price: €${regularPrice}`
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { tenantId, variantIds, productIds, priceUpdates } = await req.json();

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    console.log(`Direct WooCommerce sync: ${variantIds?.length || 0} variants, ${productIds?.length || 0} products, ${priceUpdates?.length || 0} price updates`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
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

    const results: Array<{ type: string; success: boolean; message: string }> = [];

    // Process variant stock updates
    if (variantIds && variantIds.length > 0) {
      console.log(`Processing ${variantIds.length} variant stock updates...`);

      const { data: variants, error: variantsError } = await supabase
        .from('variants')
        .select(`
          id, maat_id, size_label, ean,
          products!inner (id, sku, title),
          stock_totals (qty)
        `)
        .in('id', variantIds);

      if (variantsError) {
        console.error('Failed to fetch variants:', variantsError);
      } else if (variants) {
        for (const variant of variants) {
          try {
            const result = await updateVariantStock(variant, variant.products, wooConfig, supabase, tenantId);
            results.push({ type: 'stock', ...result });

            if (result.success) {
              console.log(`✓ ${result.message}`);
            } else {
              console.log(`✗ ${result.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            results.push({ type: 'stock', success: false, message: msg });
            console.error(`Error updating variant ${variant.id}:`, msg);
          }
        }
      }
    }

    // Process product price updates
    if (priceUpdates && priceUpdates.length > 0) {
      console.log(`Processing ${priceUpdates.length} price updates...`);

      for (const update of priceUpdates) {
        try {
          const { data: product } = await supabase
            .from('products')
            .select('id, sku, title')
            .eq('id', update.productId)
            .single();

          if (!product) {
            results.push({ type: 'price', success: false, message: `Product ${update.productId} not found` });
            continue;
          }

          const result = await updateProductPrice(product, update.regularPrice, update.listPrice, wooConfig, supabase, tenantId);
          results.push({ type: 'price', ...result });

          if (result.success) {
            console.log(`✓ ${result.message}`);
          } else {
            console.log(`✗ ${result.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          results.push({ type: 'price', success: false, message: msg });
          console.error(`Error updating price for ${update.productId}:`, msg);
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`Direct sync complete: ${successCount} succeeded, ${failCount} failed`);

    if (results.length > 0) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'DIRECT_WOO_SYNC',
        description: `Direct WooCommerce sync: ${successCount} geslaagd, ${failCount} mislukt`,
        metadata: {
          total: results.length,
          success: successCount,
          failed: failCount,
          results: results.slice(0, 20),
        },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        total: results.length,
        succeeded: successCount,
        failed: failCount,
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Direct sync error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
