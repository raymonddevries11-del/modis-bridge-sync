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
      let skippedVariants = 0;
      const errors: string[] = [];

      for (const vrdNode of Array.from(stockItems)) {
        try {
          const vrd = vrdNode as Element;
          
          // Extract artikelnummer (SKU) and mutatiecode
          const sku = vrd.querySelector('artikelnummer')?.textContent?.trim();
          const mutatieCode = vrd.querySelector('mutatiecode')?.textContent?.trim();

          if (!sku) {
            console.log('Skipping vrd - missing artikelnummer');
            skippedVariants++;
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
            console.log(`Product not found for SKU: ${sku} (might not be synced yet)`);
            skippedVariants++;
            continue;
          }

          // Get all maat elements within this vrd
          const maatElements = vrd.querySelectorAll('maat');
          
          if (maatElements.length === 0) {
            console.log(`No maat elements found for SKU: ${sku}`);
            skippedVariants++;
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

      console.log(`Stock import complete: ${updatedVariants} variants updated, ${skippedVariants} variants skipped`);
      
      if (errors.length > 0) {
        console.log(`Errors encountered (${errors.length}): ${errors.slice(0, 5).join(', ')}${errors.length > 5 ? '...' : ''}`);
      }

      // Log to changelog
      try {
        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'STOCK_IMPORT',
          description: `Voorraad bestand ${fileName} verwerkt: ${updatedVariants} variants bijgewerkt, ${skippedVariants} overgeslagen`,
          metadata: {
            filename: fileName,
            updated_variants: updatedVariants,
            skipped_variants: skippedVariants,
            error_count: errors.length,
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
