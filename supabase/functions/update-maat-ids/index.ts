import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    console.log(`Updating maat_id values from: ${fileName}`);
    
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

    console.log(`Found ${vrdElements.length} products in XML`);

    // STEP 1: Build a map from XML: SKU+size_label -> 6-digit maat_id
    // The XML has:
    // - artikelnummer: SKU (e.g., "101069102000")
    // - maat id attribute: 6-digit ID (e.g., "071041")
    // - maat-web: size label (e.g., "41 = 7½")
    // - maat-alfa: base size (e.g., "41")
    
    interface MaatMapping {
      sku: string;
      maatId: string;        // 6-digit ID from XML
      maatWeb: string;       // size_label like "41 = 7½"
      maatAlfa: string;      // base size like "41"
      ean: string | null;
    }
    
    const maatMappings: MaatMapping[] = [];

    for (const vrd of (vrdElements as any)) {
      const sku = vrd.querySelector('artikelnummer')?.textContent?.trim();
      if (!sku) continue;

      const maten = vrd.querySelectorAll('maat');
      
      for (const maat of (maten as any)) {
        const maatId = maat.getAttribute('id')?.trim();
        const maatWeb = maat.querySelector('maat-web')?.textContent?.trim();
        const maatAlfa = maat.querySelector('maat-alfa')?.textContent?.trim();
        const ean = maat.querySelector('ean-barcode')?.textContent?.trim();
        
        if (maatId && (maatWeb || maatAlfa)) {
          maatMappings.push({
            sku,
            maatId,
            maatWeb: maatWeb || maatAlfa || '',
            maatAlfa: maatAlfa || '',
            ean: ean && ean !== '0000000000000' ? ean : null
          });
        }
      }
    }

    console.log(`Built ${maatMappings.length} maat mappings from XML`);

    // STEP 2: Fetch all products to get product IDs
    console.log('Fetching products...');
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, sku')
      .eq('tenant_id', tenantId);

    if (productsError) {
      throw new Error(`Failed to fetch products: ${productsError.message}`);
    }

    const productMap = new Map<string, string>();
    for (const p of products || []) {
      productMap.set(p.sku, p.id);
    }
    console.log(`Loaded ${productMap.size} products`);

    // STEP 3: Fetch all variants with their current maat_id and size_label
    console.log('Fetching variants...');
    const productIds = Array.from(productMap.values());
    const allVariants: any[] = [];
    const BATCH_SIZE = 100;

    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      const batch = productIds.slice(i, i + BATCH_SIZE);
      const { data: variants, error } = await supabase
        .from('variants')
        .select('id, product_id, maat_id, size_label, maat_web, ean')
        .in('product_id', batch);

      if (variants) {
        allVariants.push(...variants);
      }
    }

    console.log(`Loaded ${allVariants.length} variants`);

    // Create lookup: product_id -> variants array
    const variantsByProduct = new Map<string, any[]>();
    for (const v of allVariants) {
      if (!variantsByProduct.has(v.product_id)) {
        variantsByProduct.set(v.product_id, []);
      }
      variantsByProduct.get(v.product_id)!.push(v);
    }

    // STEP 4: Match XML maat data to database variants and build updates
    console.log('Matching variants to XML data...');
    const updates: { id: string; maat_id: string }[] = [];
    let matched = 0;
    let notMatched = 0;

    for (const mapping of maatMappings) {
      const productId = productMap.get(mapping.sku);
      if (!productId) continue;

      const variants = variantsByProduct.get(productId);
      if (!variants || variants.length === 0) continue;

      // Find the variant that matches this maat entry
      // Match strategies:
      // 1. Exact match on size_label == maat_web
      // 2. Match on maat_web (database) == maat_web (XML)
      // 3. Partial match: size_label contains maat_alfa
      
      let matchedVariant = null;

      // Strategy 1: Exact size_label match
      matchedVariant = variants.find(v => 
        v.size_label === mapping.maatWeb || 
        v.size_label === mapping.maatAlfa
      );

      // Strategy 2: Match on maat_web
      if (!matchedVariant) {
        matchedVariant = variants.find(v => 
          v.maat_web === mapping.maatWeb ||
          v.maat_web === mapping.maatAlfa
        );
      }

      // Strategy 3: The old maat_id format contains the size_label
      // e.g., maat_id = "102619001000-40 = 6½", size_label = "40 = 6½"
      if (!matchedVariant) {
        matchedVariant = variants.find(v => {
          // Extract size_label from old maat_id format
          const parts = v.maat_id?.split('-');
          if (parts && parts.length >= 2) {
            const sizePart = parts.slice(1).join('-'); // Get everything after first -
            return sizePart === mapping.maatWeb || sizePart === mapping.maatAlfa;
          }
          return false;
        });
      }

      // Strategy 4: Match by EAN
      if (!matchedVariant && mapping.ean) {
        matchedVariant = variants.find(v => v.ean === mapping.ean);
      }

      if (matchedVariant) {
        // Only update if maat_id is different from the 6-digit format
        if (matchedVariant.maat_id !== mapping.maatId) {
          updates.push({
            id: matchedVariant.id,
            maat_id: mapping.maatId
          });
        }
        matched++;
      } else {
        notMatched++;
        if (notMatched <= 10) {
          console.log(`No match for SKU ${mapping.sku}, maatWeb: ${mapping.maatWeb}, maatAlfa: ${mapping.maatAlfa}`);
        }
      }
    }

    console.log(`Matched: ${matched}, Not matched: ${notMatched}, Updates needed: ${updates.length}`);

    // STEP 5: Execute batch updates
    let updatedCount = 0;
    const UPDATE_BATCH_SIZE = 100;

    for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
      const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);
      
      // Execute updates in parallel for this batch
      const results = await Promise.allSettled(
        batch.map(({ id, maat_id }) =>
          supabase
            .from('variants')
            .update({ maat_id, updated_at: new Date().toISOString() })
            .eq('id', id)
        )
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && !result.value.error) {
          updatedCount++;
        }
      }

      console.log(`Batch ${Math.floor(i / UPDATE_BATCH_SIZE) + 1}: ${updatedCount} updated so far`);
    }

    console.log(`Maat ID update complete: ${updatedCount} variants updated`);

    // Add changelog entry
    if (tenantId) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'MAAT_ID_UPDATE',
        description: `Maat ID's bijgewerkt naar 6-cijferig formaat: ${updatedCount} varianten geüpdatet uit ${fileName}`,
        metadata: {
          fileName,
          xmlMappings: maatMappings.length,
          matched,
          notMatched,
          updated: updatedCount
        }
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Maat ID update completed`,
        results: {
          xmlMappings: maatMappings.length,
          matched,
          notMatched,
          updated: updatedCount
        }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in update-maat-ids:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
