import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function parseQty(qty: string): number {
  return Number(qty.replace(/^0+/, '') || '0');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { fileName, xmlContent, tenantId } = await req.json();
    
    if (!fileName || !xmlContent) {
      return new Response(
        JSON.stringify({ error: 'Missing fileName or xmlContent' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing full stock correction: ${fileName}`);
    
    // Parse XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/html');
    
    if (!doc) {
      throw new Error('Failed to parse XML');
    }

    const vrdElements = doc.querySelectorAll('vrd');
    
    if (vrdElements.length === 0) {
      throw new Error('No stock items found in XML');
    }

    console.log(`Found ${vrdElements.length} stock items - starting background processing`);

    // Process stock in background to avoid timeout
    const processStock = async () => {
      let processedCount = 0;
      let variantsUpdated = 0;
      let skippedCount = 0;
      const errors: string[] = [];
      const changedVariantIds = new Set<string>();

      for (const vrd of (vrdElements as any)) {
        try {
          const sku = vrd.querySelector('artikelnummer')?.textContent?.trim();
          const mutatiecode = vrd.querySelector('mutatiecode')?.textContent?.trim();

          if (!sku) {
            console.log('Skipping item: no SKU');
            skippedCount++;
            continue;
          }

          // Find product by SKU and tenant_id
          const { data: product, error: productError } = await supabase
            .from('products')
            .select('id')
            .eq('sku', sku)
            .eq('tenant_id', tenantId)
            .maybeSingle();

          if (productError || !product) {
            console.log(`Product not found: ${sku}`);
            skippedCount++;
            continue;
          }

          // Process maten (variants)
          const maten = vrd.querySelectorAll('maat');

          for (const maat of (maten as any)) {
            // Use the id attribute from <maat id="011390"> instead of maat-alfa
            const maatId = maat.getAttribute('id')?.trim();
            const maatWeb = maat.querySelector('maat-web')?.textContent?.trim();
            const eanBarcode = maat.querySelector('ean-barcode')?.textContent?.trim();
            const totaalAantal = maat.querySelector('totaal-aantal')?.textContent?.trim();
            const maatActief = maat.querySelector('maat-actief')?.textContent?.trim();

            if (!maatId) {
              console.log(`Skipping variant for ${sku}: no maat-alfa`);
              continue;
            }

            // Find variant by maat_id (exact match first, then prefix fallback)
            let variant = null;
            let variantError = null;

            // Try exact match first
            const exactMatch = await supabase
              .from('variants')
              .select('id, maat_web, ean')
              .eq('product_id', product.id)
              .eq('maat_id', maatId)
              .maybeSingle();

            if (exactMatch.data) {
              variant = exactMatch.data;
            } else {
              // Try prefix matching (for backwards compatibility)
              const prefixMatch = await supabase
                .from('variants')
                .select('id, maat_id, maat_web, ean')
                .eq('product_id', product.id)
                .like('maat_id', `${maatId}%`)
                .maybeSingle();

              if (prefixMatch.data) {
                variant = prefixMatch.data;
                console.log(`Found variant ${sku} by prefix: ${prefixMatch.data.maat_id}`);
              }
            }

            if (!variant) {
              console.log(`Variant not found for ${sku} - ${maatId}`);
              continue;
            }

            // Determine stock quantity based on mutation code
            let stockQty = parseQty(totaalAantal || '0');
            if (mutatiecode === 'D') {
              stockQty = 0; // Delete = set to 0
            }

            // Check existing stock to detect changes
            const { data: existingStock } = await supabase
              .from('stock_totals')
              .select('qty')
              .eq('variant_id', variant.id)
              .maybeSingle();

            // Update stock_totals directly with totaal-aantal
            const { error: stockError } = await supabase
              .from('stock_totals')
              .upsert({
                variant_id: variant.id,
                qty: stockQty,
                updated_at: new Date().toISOString(),
              }, { onConflict: 'variant_id' });

            if (stockError) {
              console.error(`Error updating stock for variant ${variant.id}:`, stockError);
              errors.push(`${sku}-${maatId}: ${stockError.message}`);
              continue;
            }

            // Track if stock changed
            if (!existingStock || existingStock.qty !== stockQty) {
              changedVariantIds.add(variant.id);
            }

            // Update variant maat_web and ean if they differ
            const updates: any = {};
            
            if (maatWeb && maatWeb !== variant.maat_web) {
              updates.maat_web = maatWeb;
            }
            
            if (eanBarcode && eanBarcode !== '0000000000000' && eanBarcode !== variant.ean) {
              updates.ean = eanBarcode;
            }

            if (maatActief !== undefined) {
              updates.active = maatActief === '1';
            }

            // Apply variant updates if any
            if (Object.keys(updates).length > 0) {
              const { error: variantUpdateError } = await supabase
                .from('variants')
                .update(updates)
                .eq('id', variant.id);

              if (variantUpdateError) {
                console.error(`Error updating variant ${variant.id}:`, variantUpdateError);
                errors.push(`${sku}-${maatId} variant update: ${variantUpdateError.message}`);
              }
            }

            variantsUpdated++;
          }

          processedCount++;
        } catch (error: any) {
          console.error('Error processing stock item:', error);
          errors.push(error.message);
        }
      }

      console.log(`Full stock correction complete: ${processedCount} products, ${variantsUpdated} variants updated, ${skippedCount} skipped`);
      console.log(`Changed: ${changedVariantIds.size} variants (stock)`);
      
      if (errors.length > 0) {
        console.log(`Errors encountered: ${errors.length}`, errors.slice(0, 10));
      }
      
      // Create sync job if there are changes
      if (changedVariantIds.size > 0) {
        const { error: jobError } = await supabase
          .from('jobs')
          .insert({
            type: 'SYNC_TO_WOO',
            state: 'ready',
            payload: {
              variantIds: Array.from(changedVariantIds)
            },
            tenant_id: tenantId,
          });

        if (jobError) {
          console.error('Error creating sync job:', jobError);
        } else {
          console.log(`Created SYNC_TO_WOO job for ${changedVariantIds.size} variants`);
        }
      }
      
      // Add changelog entry
      if (tenantId) {
        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'STOCK_FULL_CORRECTION',
          description: `Volledige voorraad correctie uitgevoerd: ${variantsUpdated} varianten bijgewerkt van ${fileName}. ${changedVariantIds.size} varianten gewijzigd.`,
          metadata: {
            productsProcessed: processedCount,
            variantsUpdated: variantsUpdated,
            changedVariants: changedVariantIds.size,
            skipped: skippedCount,
            errors: errors.slice(0, 10),
            fileName: fileName
          }
        });
      }
    };

    // Start background processing (don't await)
    processStock().catch(err => console.error('Background processing error:', err));

    // Return immediate response
    return new Response(
      JSON.stringify({
        success: true,
        message: `Started full stock correction for ${vrdElements.length} items from ${fileName}`,
        items: vrdElements.length,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in process-stock-full:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
