import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { fileName, csvContent, tenantId } = await req.json();

    console.log(`Processing stock CSV file: ${fileName}`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse CSV
    const rows = parseCSV(csvContent);
    console.log(`Parsed ${rows.length} data rows from CSV`);

    if (rows.length === 0) {
      throw new Error('No data rows found in CSV');
    }

    // Pre-fetch all products for this tenant (bulk lookup)
    const productMap = new Map<string, { id: string }>();
    let prodOffset = 0;
    while (true) {
      const { data: products } = await supabase
        .from('products')
        .select('id, sku')
        .eq('tenant_id', tenantId)
        .range(prodOffset, prodOffset + 999);

      if (!products || products.length === 0) break;
      for (const p of products) {
        productMap.set(p.sku, { id: p.id });
      }
      if (products.length < 1000) break;
      prodOffset += 1000;
    }
    console.log(`Pre-fetched ${productMap.size} products`);

    // Pre-fetch all variants for this tenant (bulk lookup)
    const variantMap = new Map<string, { id: string; product_id: string }>();
    let varOffset = 0;
    while (true) {
      const { data: variants } = await supabase
        .from('variants')
        .select('id, maat_id, product_id')
        .in('product_id', Array.from(new Set([...productMap.values()].map(p => p.id))))
        .range(varOffset, varOffset + 999);

      if (!variants || variants.length === 0) break;
      for (const v of variants) {
        // Map by "product_id:maat_id" for quick lookup
        variantMap.set(`${v.product_id}:${v.maat_id}`, { id: v.id, product_id: v.product_id });
      }
      if (variants.length < 1000) break;
      varOffset += 1000;
    }
    console.log(`Pre-fetched ${variantMap.size} variants`);

    // Pre-fetch existing prices
    const existingPrices = new Map<string, { regular: number | null; list: number | null }>();
    let priceOffset = 0;
    while (true) {
      const { data: prices } = await supabase
        .from('product_prices')
        .select('product_id, regular, list')
        .in('product_id', Array.from(new Set([...productMap.values()].map(p => p.id))))
        .range(priceOffset, priceOffset + 999);

      if (!prices || prices.length === 0) break;
      for (const p of prices) {
        existingPrices.set(p.product_id, { regular: p.regular, list: p.list });
      }
      if (prices.length < 1000) break;
      priceOffset += 1000;
    }

    // Pre-fetch existing stock totals
    const existingStock = new Map<string, number>();
    let stockOffset = 0;
    while (true) {
      const { data: stocks } = await supabase
        .from('stock_totals')
        .select('variant_id, qty')
        .in('variant_id', Array.from(variantMap.values()).map(v => v.id))
        .range(stockOffset, stockOffset + 999);

      if (!stocks || stocks.length === 0) break;
      for (const s of stocks) {
        existingStock.set(s.variant_id, s.qty);
      }
      if (stocks.length < 1000) break;
      stockOffset += 1000;
    }

    let updatedVariants = 0;
    let updatedPrices = 0;
    let skippedRows = 0;
    const errors: string[] = [];
    const changedProductIds = new Set<string>();
    const changedVariantIds = new Set<string>();

    // Batch collections
    const priceUpserts: any[] = [];
    const stockUpserts: any[] = [];

    for (const row of rows) {
      try {
        const sku = row['SKU']?.trim();
        if (!sku) { skippedRows++; continue; }

        const regularPrice = parsePrice(row['Regular price']);
        const salePrice = parsePrice(row['Sale price']);
        const stock = parseInt(row['Stock'] || '0', 10);
        const ean = row['GTIN, UPC, EAN or ISBN']?.trim() || '';

        // Determine if this is a parent or variant row
        // Variant SKUs contain a dash: "550064001000-500734"
        const dashIndex = sku.indexOf('-');
        const isVariant = dashIndex > 0;

        if (isVariant) {
          // Variant row
          const parentSku = sku.substring(0, dashIndex);
          const maatId = sku.substring(dashIndex + 1);

          const product = productMap.get(parentSku);
          if (!product) {
            skippedRows++;
            continue;
          }

          // Find variant
          const variantKey = `${product.id}:${maatId}`;
          const variant = variantMap.get(variantKey);

          if (!variant) {
            // Try suffix match (e.g., "500734" matching "500734" or longer maat_id ending with it)
            let found = false;
            for (const [key, v] of variantMap.entries()) {
              if (key.startsWith(`${product.id}:`) && key.endsWith(maatId)) {
                // Update stock for this variant
                const oldQty = existingStock.get(v.id) ?? -1;
                if (oldQty !== stock) {
                  stockUpserts.push({
                    variant_id: v.id,
                    qty: stock,
                    updated_at: new Date().toISOString(),
                  });
                  changedVariantIds.add(v.id);
                }
                updatedVariants++;
                found = true;
                break;
              }
            }
            if (!found) skippedRows++;
            continue;
          }

          // Update stock
          const oldQty = existingStock.get(variant.id) ?? -1;
          if (oldQty !== stock) {
            stockUpserts.push({
              variant_id: variant.id,
              qty: stock,
              updated_at: new Date().toISOString(),
            });
            changedVariantIds.add(variant.id);
          }
          updatedVariants++;

        } else {
          // Parent row - update prices
          const product = productMap.get(sku);
          if (!product) {
            skippedRows++;
            continue;
          }

          if (regularPrice !== null || salePrice !== null) {
            const existing = existingPrices.get(product.id);
            const newRegular = regularPrice;
            // In WooCommerce CSV: "Sale price" maps to the current selling price (list)
            const newList = salePrice;

            if (!existing ||
                existing.regular !== newRegular ||
                existing.list !== newList) {
              priceUpserts.push({
                product_id: product.id,
                regular: newRegular,
                list: newList,
              });
              changedProductIds.add(product.id);
            }
            updatedPrices++;
          }
        }
      } catch (rowError) {
        const error = rowError as Error;
        errors.push(`Row error: ${error.message}`);
      }
    }

    // Batch upsert prices (500 at a time)
    for (let i = 0; i < priceUpserts.length; i += 500) {
      const batch = priceUpserts.slice(i, i + 500);
      const { error } = await supabase
        .from('product_prices')
        .upsert(batch, { onConflict: 'product_id' });
      if (error) errors.push(`Price batch error: ${error.message}`);
    }

    // Batch upsert stock totals (500 at a time)
    for (let i = 0; i < stockUpserts.length; i += 500) {
      const batch = stockUpserts.slice(i, i + 500);
      const { error } = await supabase
        .from('stock_totals')
        .upsert(batch, { onConflict: 'variant_id' });
      if (error) errors.push(`Stock batch error: ${error.message}`);
    }

    console.log(`CSV import complete: ${updatedVariants} variants, ${updatedPrices} prices, ${skippedRows} skipped`);
    console.log(`Changed: ${changedProductIds.size} products (price), ${changedVariantIds.size} variants (stock)`);

    // Trigger direct WooCommerce sync for changes
    if (changedProductIds.size > 0 || changedVariantIds.size > 0) {
      console.log(`Direct syncing to WooCommerce: ${changedProductIds.size} products, ${changedVariantIds.size} variants`);
      try {
        const syncPayload: any = { tenantId };
        if (changedVariantIds.size > 0) {
          syncPayload.variantIds = Array.from(changedVariantIds);
        }
        if (changedProductIds.size > 0) {
          const { data: priceData } = await supabase
            .from('product_prices')
            .select('product_id, regular, list')
            .in('product_id', Array.from(changedProductIds));
          if (priceData && priceData.length > 0) {
            syncPayload.priceUpdates = priceData.map(p => ({
              productId: p.product_id,
              regularPrice: p.regular,
              listPrice: p.list,
            }));
          }
        }
        const { error: syncError } = await supabase.functions.invoke('direct-woo-sync', {
          body: syncPayload,
        });
        if (syncError) console.error('Direct WooCommerce sync failed:', syncError);
        else console.log('Direct WooCommerce sync triggered');
      } catch (syncErr) {
        console.error('Error invoking direct-woo-sync:', syncErr);
      }
    }

    // Log to changelog
    try {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'STOCK_CSV_IMPORT',
        description: `Voorraad CSV ${fileName} verwerkt: ${updatedVariants} voorraad, ${updatedPrices} prijzen bijgewerkt, ${skippedRows} overgeslagen. ${changedProductIds.size} prijswijzigingen, ${changedVariantIds.size} voorraadwijzigingen.`,
        metadata: {
          filename: fileName,
          updated_variants: updatedVariants,
          updated_prices: updatedPrices,
          skipped_rows: skippedRows,
          changed_products: changedProductIds.size,
          changed_variants: changedVariantIds.size,
          error_count: errors.length,
          errors: errors.slice(0, 10),
        },
      });
    } catch (logError) {
      console.error('Failed to log to changelog:', logError);
    }

    return new Response(
      JSON.stringify({
        message: `Processed ${rows.length} rows from ${fileName}`,
        updatedVariants,
        updatedPrices,
        skippedRows,
        changedProducts: changedProductIds.size,
        changedVariants: changedVariantIds.size,
        errors: errors.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (err) {
    const error = err as Error;
    console.error('Error in process-stock-csv:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function parsePrice(value: string | undefined): number | null {
  if (!value || value.trim() === '') return null;
  const num = parseFloat(value.replace(',', '.'));
  return isNaN(num) ? null : num;
}
