/// <reference lib="deno.ns" />
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DOMParser, Element } from 'https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to parse quantity
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
    const xmlDoc = parser.parseFromString(xmlContent, 'text/xml');

    if (!xmlDoc) {
      throw new Error('Failed to parse XML');
    }

    // Get all stock items (voorraad items)
    const stockItems = xmlDoc.querySelectorAll('ArtikelVoorraad');

    if (stockItems.length === 0) {
      throw new Error('No stock items found in XML');
    }

    console.log(`Found ${stockItems.length} stock items - starting background processing`);

    // Start background processing
    const processStock = async () => {
      let updatedCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      for (const itemNode of Array.from(stockItems)) {
        try {
          const item = itemNode as Element;
          
          // Extract data from XML
          const sku = item.querySelector('ArtikelNummer')?.textContent?.trim();
          const storeId = item.querySelector('VestigingsNummer')?.textContent?.trim();
          const qtyText = item.querySelector('Voorraad')?.textContent?.trim();

          if (!sku || !storeId || !qtyText) {
            console.log(`Skipping item - missing data: SKU=${sku}, Store=${storeId}, Qty=${qtyText}`);
            skippedCount++;
            continue;
          }

          const qty = parseQty(qtyText);

          // Find variant by SKU (via product)
          const { data: product } = await supabase
            .from('products')
            .select('id, variants(id, maat_id)')
            .eq('sku', sku)
            .eq('tenant_id', tenantId)
            .single();

          if (!product || !product.variants || product.variants.length === 0) {
            console.log(`Product/variant not found for SKU: ${sku}`);
            skippedCount++;
            continue;
          }

          // Update stock for all variants of this product
          for (const variant of product.variants) {
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
              console.error(`Error updating stock_by_store for variant ${variant.id}:`, storeError);
              errors.push(`Stock by store error for ${sku}: ${storeError.message}`);
              continue;
            }

            // Calculate and update total stock for this variant
            const { data: storeStocks } = await supabase
              .from('stock_by_store')
              .select('qty')
              .eq('variant_id', variant.id);

            const totalQty = storeStocks?.reduce((sum, s) => sum + (s.qty || 0), 0) || 0;

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
              console.error(`Error updating stock_totals for variant ${variant.id}:`, totalError);
              errors.push(`Stock total error for ${sku}: ${totalError.message}`);
            } else {
              updatedCount++;
            }
          }
        } catch (itemError) {
          const error = itemError as Error;
          console.error('Error processing stock item:', error);
          errors.push(`Item error: ${error.message}`);
        }
      }

      console.log(`Stock import complete: ${updatedCount} updated, ${skippedCount} skipped`);
      
      if (errors.length > 0) {
        console.log(`Errors encountered: ${errors.join(', ')}`);
      }

      // Log to changelog
      try {
        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'STOCK_IMPORT',
          description: `Voorraad bestand ${fileName} verwerkt: ${updatedCount} bijgewerkt, ${skippedCount} overgeslagen`,
          metadata: {
            filename: fileName,
            updated_count: updatedCount,
            skipped_count: skippedCount,
            error_count: errors.length,
          },
        });
      } catch (logError) {
        console.error('Failed to log to changelog:', logError);
      }
    };

    // Start background processing (waitUntil available in newer Deno versions)
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
