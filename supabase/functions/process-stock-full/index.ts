import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalizeSku(input: string): string {
  // Keep only digits to avoid hidden whitespace / separators from XML exports
  return (input || '').replace(/\D/g, '');
}

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
    const { fileName, xmlContent, xmlUrl, tenantId } = await req.json();
    
    let actualXmlContent = xmlContent;
    let actualFileName = fileName;
    
    // If xmlUrl is provided, fetch the XML content from that URL
    if (xmlUrl && !xmlContent) {
      console.log(`Fetching XML from URL: ${xmlUrl}`);
      const response = await fetch(xmlUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch XML from URL: ${response.status} ${response.statusText}`);
      }
      actualXmlContent = await response.text();
      actualFileName = fileName || xmlUrl.split('/').pop() || 'unknown.xml';
      console.log(`Fetched ${actualXmlContent.length} bytes from URL`);
    }
    
    if (!actualFileName || !actualXmlContent) {
      return new Response(
        JSON.stringify({ error: 'Missing fileName/xmlContent or xmlUrl' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing full stock correction: ${actualFileName}`);
    
    // Parse XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(actualXmlContent, 'text/html');
    
    if (!doc) {
      throw new Error('Failed to parse XML');
    }

    const vrdElements = doc.querySelectorAll('vrd');
    
    if (vrdElements.length === 0) {
      throw new Error('No stock items found in XML');
    }

    console.log(`Found ${vrdElements.length} stock items`);

    // STEP 1: Build a SKU set from the XML first (fast, avoids fetching unrelated products)
    console.log('Collecting SKUs from XML...');
    const xmlSkus = new Set<string>();
    for (const vrd of (vrdElements as any)) {
      const rawSku = vrd.querySelector('artikelnummer')?.textContent?.trim();
      const sku = rawSku ? normalizeSku(rawSku) : '';
      if (sku) xmlSkus.add(sku);
    }
    console.log(`Collected ${xmlSkus.size} unique SKUs from XML`);

    // STEP 2: Fetch ONLY products that are present in the XML (batched)
    console.log('Fetching products for XML SKUs...');
    const allProducts: any[] = [];
    const SKU_BATCH_SIZE = 200;
    const xmlSkuList = Array.from(xmlSkus);

    for (let i = 0; i < xmlSkuList.length; i += SKU_BATCH_SIZE) {
      const batchSkus = xmlSkuList.slice(i, i + SKU_BATCH_SIZE);
      const { data: batch, error: productsError } = await supabase
        .from('products')
        .select('id, sku')
        .eq('tenant_id', tenantId)
        .in('sku', batchSkus);

      if (productsError) {
        throw new Error(`Failed to fetch products: ${productsError.message}`);
      }

      if (batch && batch.length > 0) {
        allProducts.push(...batch);
      }
    }

    // Create SKU -> product map for fast lookup (normalized to digits)
    const productMap = new Map<string, string>();
    for (const p of allProducts || []) {
      productMap.set(normalizeSku(p.sku), p.id);
    }
    console.log(`Loaded ${productMap.size} products into memory (from XML)`);

    // STEP 3: Pre-fetch all variants for the XML products (batched to avoid URL length limits)
    const productIds = Array.from(productMap.values());
    console.log(`Fetching variants for ${productIds.length} products...`);

    const allVariants: any[] = [];
    const PRODUCT_BATCH_SIZE = 150;

    for (let i = 0; i < productIds.length; i += PRODUCT_BATCH_SIZE) {
      const batchIds = productIds.slice(i, i + PRODUCT_BATCH_SIZE);
      const { data: batchVariants, error: variantsError } = await supabase
        .from('variants')
        .select('id, product_id, maat_id, maat_web, ean')
        .in('product_id', batchIds);

      if (variantsError) {
        console.error(`Batch ${i / PRODUCT_BATCH_SIZE + 1} variants error:`, variantsError);
        continue;
      }

      if (batchVariants) {
        allVariants.push(...batchVariants);
      }
    }

    // Create lookup maps for variants
    const variantByProductId = new Map<string, any[]>();

    for (const v of allVariants || []) {
      if (!variantByProductId.has(v.product_id)) {
        variantByProductId.set(v.product_id, []);
      }
      variantByProductId.get(v.product_id)!.push(v);
    }
    console.log(`Loaded ${allVariants.length} variants into memory`);

    // STEP 4: Pre-fetch existing stock totals (batched)
    const variantIds = allVariants.map(v => v.id);
    console.log(`Fetching stock totals for ${variantIds.length} variants...`);

    const existingStocks: any[] = [];
    const VARIANT_BATCH_SIZE = 300;

    for (let i = 0; i < variantIds.length; i += VARIANT_BATCH_SIZE) {
      const batchIds = variantIds.slice(i, i + VARIANT_BATCH_SIZE);
      const { data: batchStocks } = await supabase
        .from('stock_totals')
        .select('variant_id, qty')
        .in('variant_id', batchIds);

      if (batchStocks) {
        existingStocks.push(...batchStocks);
      }
    }

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
    const processedVariantIds = new Set<string>(); // Track which variants were in the XML

    for (const vrd of (vrdElements as any)) {
      try {
        const rawSku = vrd.querySelector('artikelnummer')?.textContent?.trim();
        const sku = rawSku ? normalizeSku(rawSku) : '';
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
        
        // Debug: log first few products and their maten
        if (processedCount < 3) {
          console.log(`DEBUG SKU ${sku}: found ${maten.length} maten, productId: ${productId}`);
          const productVariants = variantByProductId.get(productId);
          console.log(`DEBUG: Product has ${productVariants?.length || 0} variants in DB`);
          if (productVariants && productVariants.length > 0) {
            console.log(`DEBUG: First variant maat_id: ${productVariants[0].maat_id}`);
          }
        }

        for (const maat of (maten as any)) {
          const maatId = maat.getAttribute('id')?.trim();
          const maatWeb = maat.querySelector('maat-web')?.textContent?.trim();
          const eanBarcode = maat.querySelector('ean-barcode')?.textContent?.trim();
          const totaalAantal = maat.querySelector('totaal-aantal')?.textContent?.trim();
          const maatActief = maat.querySelector('maat-actief')?.textContent?.trim();

          if (!maatId) continue;
          
          // Find variant using in-memory lookup
          // maat_id in database is a 6-digit code like "011430" matching XML's maat id attribute
          const productVariants = variantByProductId.get(productId);
          let variant = productVariants?.find(v => v.maat_id === maatId);
          
          // Debug: log first few maat lookups
          if (processedCount < 3) {
            console.log(`DEBUG SKU ${sku}: looking for maat_id "${maatId}", found: ${variant ? 'YES' : 'NO'}`);
            if (!variant && productVariants) {
              console.log(`DEBUG: Available maat_ids: ${productVariants.map(v => v.maat_id).join(', ')}`);
            }
          }

          if (!variant) continue;

          // Mark this variant as processed (it's in the XML)
          processedVariantIds.add(variant.id);

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

    // STEP 4b: Set stock to 0 for variants NOT in the XML but with stock > 0
    console.log('Checking for variants not in XML that need to be zeroed...');
    let zeroedCount = 0;
    
    for (const variant of allVariants) {
      // Skip variants that were processed from XML
      if (processedVariantIds.has(variant.id)) continue;
      
      // Check if this variant has stock > 0
      const currentStock = stockMap.get(variant.id);
      if (currentStock !== undefined && currentStock > 0) {
        // This variant has stock but was NOT in the XML - set to 0
        stockUpdates.push({
          variant_id: variant.id,
          qty: 0,
          updated_at: new Date().toISOString(),
        });
        changedVariantIds.add(variant.id);
        zeroedCount++;
        
        if (zeroedCount <= 10) {
          console.log(`Zeroing variant ${variant.id} (maat_id: ${variant.maat_id}) - was ${currentStock}, not in XML`);
        }
      }
    }
    
    if (zeroedCount > 10) {
      console.log(`... and ${zeroedCount - 10} more variants zeroed`);
    }
    console.log(`Total variants zeroed (not in XML): ${zeroedCount}`);

    console.log(`Parsed: ${processedCount} products, ${stockUpdates.length} stock updates, ${changedVariantIds.size} changes, ${zeroedCount} zeroed`);

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
        description: `Volledige voorraad correctie uitgevoerd: ${stockUpdates.length} varianten bijgewerkt van ${actualFileName}. ${changedVariantIds.size} varianten gewijzigd, ${zeroedCount} op 0 gezet (niet in XML).`,
        metadata: {
          productsProcessed: processedCount,
          variantsUpdated: stockUpdates.length,
          changedVariants: changedVariantIds.size,
          zeroedNotInXml: zeroedCount,
          skipped: skippedCount,
          errors: errors.slice(0, 10),
          fileName: actualFileName
        }
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Full stock correction completed for ${actualFileName}`,
        results: {
          productsProcessed: processedCount,
          variantsUpdated: stockUpdates.length,
          changedVariants: changedVariantIds.size,
          zeroedNotInXml: zeroedCount,
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
