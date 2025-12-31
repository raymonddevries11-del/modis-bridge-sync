/// <reference lib="deno.ns" />
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DOMParser, Element } from 'https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to parse quantity (removes leading zeros)
function parseQty(qty: string): number {
  return parseInt(qty.replace(/^0+/, '') || '0', 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { fileName, xmlContent, tenantId } = await req.json();

    console.log(`Processing stock file: ${fileName}`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse XML
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlContent, 'text/html'); // Use text/html for more lenient parsing

    if (!xmlDoc) {
      throw new Error('Failed to parse XML');
    }

    // Get all voorraad items (vrd elements)
    const stockItems = xmlDoc.querySelectorAll('vrd');

    if (stockItems.length === 0) {
      throw new Error('No stock items (vrd) found in XML');
    }

    console.log(`Found ${stockItems.length} stock items (vrd) - starting background processing`);

    // Start background processing
    const processStock = async () => {
      let updatedVariants = 0;
      let updatedPrices = 0;
      let skippedVariants = 0;
      const errors: string[] = [];
      const skippedItems: Array<{ sku: string; reason: string }> = [];
      const changedProductIds = new Set<string>();
      const changedVariantIds = new Set<string>();

      for (const vrdNode of Array.from(stockItems)) {
        try {
          const vrd = vrdNode as Element;
          
          // Extract artikelnummer (SKU) and mutatiecode
          const sku = vrd.querySelector('artikelnummer')?.textContent?.trim();
          const mutatieCode = vrd.querySelector('mutatiecode')?.textContent?.trim();
          
          // Extract price information
          const regularPriceText = vrd.querySelector('verkoopprijs')?.textContent?.trim();
          const listPriceText = vrd.querySelector('lopende-verkoopprijs')?.textContent?.trim();

          if (!sku) {
            console.log('Skipping vrd - missing artikelnummer');
            skippedVariants++;
            skippedItems.push({ sku: 'ONBEKEND', reason: 'Geen artikelnummer in XML' });
            continue;
          }

          console.log(`Processing SKU: ${sku}, Mutatiecode: ${mutatieCode}`);

          // Find product by SKU
          const { data: product } = await supabase
            .from('products')
            .select('id')
            .eq('sku', sku)
            .eq('tenant_id', tenantId)
            .maybeSingle();

          if (!product) {
            console.log(`❌ Product not found for SKU: ${sku} (tenant: ${tenantId}) - artikel bestand nog niet verwerkt?`);
            skippedVariants++;
            skippedItems.push({ 
              sku: sku, 
              reason: 'Product niet gevonden in database (artikel bestand nog niet verwerkt?)' 
            });
            continue;
          }

          // Update prices if present in XML
          if (regularPriceText || listPriceText) {
            const regularPrice = regularPriceText ? parseFloat(regularPriceText.replace(',', '.')) : null;
            const listPrice = listPriceText ? parseFloat(listPriceText.replace(',', '.')) : null;

            if (regularPrice !== null || listPrice !== null) {
              // Check existing price to detect changes
              const { data: existingPrice } = await supabase
                .from('product_prices')
                .select('regular, list')
                .eq('product_id', product.id)
                .maybeSingle();

              const priceUpdate: any = { product_id: product.id };
              if (regularPrice !== null) priceUpdate.regular = regularPrice;
              if (listPrice !== null) priceUpdate.list = listPrice;
              
              const { error: priceError } = await supabase
                .from('product_prices')
                .upsert(priceUpdate, { onConflict: 'product_id' });

              if (priceError) {
                console.error(`Error updating price for SKU ${sku}:`, priceError);
                errors.push(`Price error for ${sku}: ${priceError.message}`);
              } else {
                updatedPrices++;
                console.log(`  Updated price: regular=${regularPrice}, list=${listPrice}`);
                
                // Track if price actually changed
                if (!existingPrice || 
                    existingPrice.regular !== regularPrice || 
                    existingPrice.list !== listPrice) {
                  changedProductIds.add(product.id);
                }
              }
            }
          }

          // Get all maat elements within this vrd
          const maatElements = vrd.querySelectorAll('maat');
          
          if (maatElements.length === 0) {
            console.log(`No maat elements found for SKU: ${sku}`);
            skippedVariants++;
            skippedItems.push({ sku: sku, reason: 'Geen maat/variant informatie in XML' });
            continue;
          }

          // Process each maat (variant)
          for (const maatNode of Array.from(maatElements)) {
            try {
              const maat = maatNode as Element;
              
              // Get maat_id from id attribute
              const maatId = maat.getAttribute('id')?.trim();
              const ean = maat.querySelector('ean-barcode')?.textContent?.trim();
              const totaalAantal = maat.querySelector('totaal-aantal')?.textContent?.trim();

              if (!maatId) {
                console.log(`Skipping maat - missing id attribute for SKU: ${sku}`);
                continue;
              }

              console.log(`  Processing variant maat_id: ${maatId}, EAN: ${ean}, Total: ${totaalAantal}`);

              // Find variant by product_id and maat_id
              // Try to find exact match first, then with prefix pattern
              let { data: variant } = await supabase
                .from('variants')
                .select('id')
                .eq('product_id', product.id)
                .eq('maat_id', maatId)
                .maybeSingle();

              // If not found, try with wildcard matching (e.g., '040' matches '002040')
              if (!variant) {
                const { data: variantWithPrefix } = await supabase
                  .from('variants')
                  .select('id, maat_id')
                  .eq('product_id', product.id)
                  .like('maat_id', `%${maatId}`)
                  .maybeSingle();
                
                variant = variantWithPrefix;
                
                if (variant) {
                  console.log(`  Found variant with prefix: maat_id ${(variant as any).maat_id} matches ${maatId}`);
                }
              }

              if (!variant) {
                console.log(`  Variant not found for SKU: ${sku}, maat_id: ${maatId}`);
                skippedVariants++;
                skippedItems.push({ 
                  sku: `${sku} (maat: ${maatId})`, 
                  reason: 'Variant niet gevonden in database' 
                });
                continue;
              }

              // Determine quantity based on mutatiecode
              let shouldDelete = false;
              if (mutatieCode === 'D') {
                // Delete: set all stock to 0
                shouldDelete = true;
                console.log(`  Mutatiecode D: Setting all stock to 0 for variant ${variant.id}`);
              }

              // Get all filiaal elements for store-specific stock
              const filiaalElements = maat.querySelectorAll('filiaal');
              
              if (filiaalElements.length === 0) {
                console.log(`  No filiaal elements found for maat_id: ${maatId}`);
              }

              // Process each store location
              for (const filiaalNode of Array.from(filiaalElements)) {
                try {
                  const filiaal = filiaalNode as Element;
                  
                  // Get store_id from id attribute
                  const storeId = filiaal.getAttribute('id')?.trim();
                  const aantalText = filiaal.querySelector('Aantal')?.textContent?.trim();

                  if (!storeId || !aantalText) {
                    console.log(`    Skipping filiaal - missing id or Aantal`);
                    continue;
                  }

                  const qty = shouldDelete ? 0 : parseQty(aantalText);

                  console.log(`    Store ${storeId}: ${qty} items`);

                  // Upsert stock by store
                  const { error: storeError } = await supabase
                    .from('stock_by_store')
                    .upsert({
                      variant_id: variant.id,
                      store_id: storeId,
                      qty: qty,
                      updated_at: new Date().toISOString(),
                    }, {
                      onConflict: 'variant_id,store_id',
                    });

                  if (storeError) {
                    console.error(`    Error updating stock_by_store:`, storeError);
                    errors.push(`Stock by store error for ${sku}/${maatId}/${storeId}: ${storeError.message}`);
                  }
                } catch (filiaalError) {
                  const error = filiaalError as Error;
                  console.error('    Error processing filiaal:', error);
                  errors.push(`Filiaal error for ${sku}/${maatId}: ${error.message}`);
                }
              }

              // Calculate and update total stock for this variant
              const { data: storeStocks } = await supabase
                .from('stock_by_store')
                .select('qty')
                .eq('variant_id', variant.id);

              const totalQty = storeStocks?.reduce((sum, s) => sum + (s.qty || 0), 0) || 0;

              console.log(`  Total stock for variant ${variant.id}: ${totalQty}`);

              // Check existing stock to detect changes
              const { data: existingStock } = await supabase
                .from('stock_totals')
                .select('qty')
                .eq('variant_id', variant.id)
                .maybeSingle();

              const { error: totalError } = await supabase
                .from('stock_totals')
                .upsert({
                  variant_id: variant.id,
                  qty: totalQty,
                  updated_at: new Date().toISOString(),
                }, {
                  onConflict: 'variant_id',
                });

              if (totalError) {
                console.error(`  Error updating stock_totals:`, totalError);
                errors.push(`Stock total error for ${sku}/${maatId}: ${totalError.message}`);
              } else {
                updatedVariants++;
                
                // Track if stock actually changed
                if (!existingStock || existingStock.qty !== totalQty) {
                  changedVariantIds.add(variant.id);
                }
              }

            } catch (maatError) {
              const error = maatError as Error;
              console.error('  Error processing maat:', error);
              errors.push(`Maat error for ${sku}: ${error.message}`);
            }
          }
        } catch (vrdError) {
          const error = vrdError as Error;
          console.error('Error processing vrd:', error);
          errors.push(`VRD error: ${error.message}`);
        }
      }

      console.log(`Stock import complete: ${updatedVariants} variants updated, ${updatedPrices} prices updated, ${skippedVariants} variants skipped`);
      console.log(`Changed: ${changedProductIds.size} products (price), ${changedVariantIds.size} variants (stock)`);
      
      if (errors.length > 0) {
        console.log(`Errors encountered (${errors.length}): ${errors.slice(0, 5).join(', ')}${errors.length > 5 ? '...' : ''}`);
      }

      if (skippedItems.length > 0) {
        console.log(`Skipped items (${skippedItems.length}):`);
        skippedItems.forEach(item => console.log(`  - ${item.sku}: ${item.reason}`));
      }

      // Direct sync to WooCommerce if there are changes (no more job queue)
      if (changedProductIds.size > 0 || changedVariantIds.size > 0) {
        console.log(`Direct syncing to WooCommerce: ${changedProductIds.size} products, ${changedVariantIds.size} variants`);
        
        try {
          // Invoke direct-woo-sync function
          const syncPayload: any = { tenantId };
          
          if (changedVariantIds.size > 0) {
            syncPayload.variantIds = Array.from(changedVariantIds);
          }
          
          // For price changes, prepare price updates array
          if (changedProductIds.size > 0) {
            // Fetch current prices for changed products
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
            body: syncPayload
          });

          if (syncError) {
            console.error('Direct WooCommerce sync failed:', syncError);
          } else {
            console.log(`Direct WooCommerce sync triggered for ${changedProductIds.size} products and ${changedVariantIds.size} variants`);
          }
        } catch (syncErr) {
          console.error('Error invoking direct-woo-sync:', syncErr);
        }
      }

      // Log to changelog
      try {
        const description = skippedItems.length > 0
          ? `Voorraad & prijs bestand ${fileName} verwerkt: ${updatedVariants} voorraad bijgewerkt, ${updatedPrices} prijzen bijgewerkt, ${skippedVariants} overgeslagen. ${changedProductIds.size} producten en ${changedVariantIds.size} varianten gewijzigd. Overgeslagen: ${skippedItems.map(i => i.sku).join(', ')}`
          : `Voorraad & prijs bestand ${fileName} verwerkt: ${updatedVariants} voorraad bijgewerkt, ${updatedPrices} prijzen bijgewerkt, ${skippedVariants} overgeslagen. ${changedProductIds.size} producten en ${changedVariantIds.size} varianten gewijzigd.`;

        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'STOCK_IMPORT',
          description: description,
          metadata: {
            filename: fileName,
            updated_variants: updatedVariants,
            updated_prices: updatedPrices,
            skipped_variants: skippedVariants,
            changedProducts: changedProductIds.size,
            changedVariants: changedVariantIds.size,
            error_count: errors.length,
            skipped_items: skippedItems,
            errors: errors.slice(0, 10),
          },
        });
      } catch (logError) {
        console.error('Failed to log to changelog:', logError);
      }
    };

    // Start background processing
    processStock();

    // Return immediate response
    return new Response(
      JSON.stringify({
        message: `Started processing ${stockItems.length} stock items from ${fileName}`,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (err) {
    const error = err as Error;
    console.error('Error in process-stock function:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
