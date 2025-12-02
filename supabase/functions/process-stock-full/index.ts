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

    console.log(`Found ${vrdElements.length} stock items`);

    // STEP 1: Pre-fetch all products for this tenant (bulk query)
    console.log('Fetching all products for tenant...');
    const { data: allProducts, error: productsError } = await supabase
      .from('products')
      .select('id, sku')
      .eq('tenant_id', tenantId);

    if (productsError) {
      throw new Error(`Failed to fetch products: ${productsError.message}`);
    }

    // Create SKU -> product map for fast lookup
    const productMap = new Map<string, string>();
    for (const p of allProducts || []) {
      productMap.set(p.sku, p.id);
    }
    console.log(`Loaded ${productMap.size} products into memory`);

    // STEP 2: Pre-fetch all variants for products (bulk query)
    const productIds = Array.from(productMap.values());
    console.log('Fetching all variants...');
    const { data: allVariants, error: variantsError } = await supabase
      .from('variants')
      .select('id, product_id, maat_id, maat_web, ean')
      .in('product_id', productIds);

    if (variantsError) {
      throw new Error(`Failed to fetch variants: ${variantsError.message}`);
    }

    // Create lookup maps for variants
    // Key: productId-maatId -> variant
    const variantMap = new Map<string, any>();
    const variantByPrefix = new Map<string, any[]>();
    
    for (const v of allVariants || []) {
      const exactKey = `${v.product_id}-${v.maat_id}`;
      variantMap.set(exactKey, v);
      
      // Also index by prefix for fallback matching
      const prefixKey = `${v.product_id}-${v.maat_id.substring(0, 6)}`;
      if (!variantByPrefix.has(prefixKey)) {
        variantByPrefix.set(prefixKey, []);
      }
      variantByPrefix.get(prefixKey)!.push(v);
    }
    console.log(`Loaded ${variantMap.size} variants into memory`);

    // STEP 3: Pre-fetch existing stock totals (bulk query)
    const variantIds = (allVariants || []).map(v => v.id);
    console.log('Fetching existing stock totals...');
    const { data: existingStocks } = await supabase
      .from('stock_totals')
      .select('variant_id, qty')
      .in('variant_id', variantIds);

    const stockMap = new Map<string, number>();
    for (const s of existingStocks || []) {
      stockMap.set(s.variant_id, s.qty);
    }
    console.log(`Loaded ${stockMap.size} stock records into memory`);

    // STEP 4: Process XML and build batch operations
    console.log('Processing XML items...');
    let processedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];
    const stockUpdates: { variant_id: string; qty: number; updated_at: string }[] = [];
    const variantUpdates: { id: string; updates: any }[] = [];
    const changedVariantIds = new Set<string>();

    for (const vrd of (vrdElements as any)) {
      try {
        const sku = vrd.querySelector('artikelnummer')?.textContent?.trim();
        const mutatiecode = vrd.querySelector('mutatiecode')?.textContent?.trim();

        if (!sku) {
          skippedCount++;
          continue;
        }

        const productId = productMap.get(sku);
        if (!productId) {
          skippedCount++;
          continue;
        }

        // Process maten (variants)
        const maten = vrd.querySelectorAll('maat');

        for (const maat of (maten as any)) {
          const maatId = maat.getAttribute('id')?.trim();
          const maatWeb = maat.querySelector('maat-web')?.textContent?.trim();
          const eanBarcode = maat.querySelector('ean-barcode')?.textContent?.trim();
          const totaalAantal = maat.querySelector('totaal-aantal')?.textContent?.trim();
          const maatActief = maat.querySelector('maat-actief')?.textContent?.trim();

          if (!maatId) continue;

          // Find variant using in-memory lookup
          const exactKey = `${productId}-${maatId}`;
          let variant = variantMap.get(exactKey);

          if (!variant) {
            // Try prefix matching
            const prefixKey = `${productId}-${maatId.substring(0, 6)}`;
            const prefixMatches = variantByPrefix.get(prefixKey);
            if (prefixMatches && prefixMatches.length > 0) {
              variant = prefixMatches.find(v => v.maat_id.startsWith(maatId));
            }
          }

          if (!variant) continue;

          // Determine stock quantity
          let stockQty = parseQty(totaalAantal || '0');
          if (mutatiecode === 'D') {
            stockQty = 0;
          }

          // Track stock change
          const currentStock = stockMap.get(variant.id);
          if (currentStock === undefined || currentStock !== stockQty) {
            changedVariantIds.add(variant.id);
          }

          // Add to batch updates
          stockUpdates.push({
            variant_id: variant.id,
            qty: stockQty,
            updated_at: new Date().toISOString(),
          });

          // Check for variant attribute updates
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

          if (Object.keys(updates).length > 0) {
            variantUpdates.push({ id: variant.id, updates });
          }
        }

        processedCount++;
      } catch (error: any) {
        errors.push(error.message);
      }
    }

    console.log(`Parsed: ${processedCount} products, ${stockUpdates.length} stock updates, ${changedVariantIds.size} changes`);

    // STEP 5: Execute batch stock updates
    console.log('Executing batch stock updates...');
    const BATCH_SIZE = 500;
    let stockUpdateErrors = 0;

    for (let i = 0; i < stockUpdates.length; i += BATCH_SIZE) {
      const batch = stockUpdates.slice(i, i + BATCH_SIZE);
      const { error: batchError } = await supabase
        .from('stock_totals')
        .upsert(batch, { onConflict: 'variant_id' });

      if (batchError) {
        console.error(`Batch ${i / BATCH_SIZE + 1} error:`, batchError);
        stockUpdateErrors++;
        errors.push(`Batch error: ${batchError.message}`);
      }
    }
    console.log(`Stock updates complete: ${stockUpdates.length} items in ${Math.ceil(stockUpdates.length / BATCH_SIZE)} batches`);

    // STEP 6: Execute variant updates (individually, they're few)
    console.log(`Executing ${variantUpdates.length} variant updates...`);
    for (const { id, updates } of variantUpdates) {
      const { error: variantUpdateError } = await supabase
        .from('variants')
        .update(updates)
        .eq('id', id);

      if (variantUpdateError) {
        errors.push(`Variant ${id}: ${variantUpdateError.message}`);
      }
    }

    console.log(`Full stock correction complete: ${processedCount} products, ${stockUpdates.length} variants`);
    console.log(`Changed: ${changedVariantIds.size} variants`);
    
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
        description: `Volledige voorraad correctie uitgevoerd: ${stockUpdates.length} varianten bijgewerkt van ${fileName}. ${changedVariantIds.size} varianten gewijzigd.`,
        metadata: {
          productsProcessed: processedCount,
          variantsUpdated: stockUpdates.length,
          changedVariants: changedVariantIds.size,
          skipped: skippedCount,
          errors: errors.slice(0, 10),
          fileName: fileName
        }
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Full stock correction completed for ${fileName}`,
        results: {
          productsProcessed: processedCount,
          variantsUpdated: stockUpdates.length,
          changedVariants: changedVariantIds.size,
          skipped: skippedCount,
          errors: errors.length,
          syncJobCreated: changedVariantIds.size > 0
        }
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
