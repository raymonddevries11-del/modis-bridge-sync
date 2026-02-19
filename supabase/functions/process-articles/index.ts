import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper functions
function parsePrice(price: string): number {
  if (!price) return 0;
  return parseFloat(price.replace(',', '.').replace(/^0+/, '') || '0');
}

function parseInteger(value: string): number {
  if (!value) return 0;
  return Number(value.replace(/^0+/, '') || '0');
}

function extractPhotos(artikel: any, supabaseUrl: string): string[] {
  const photos: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const fotoKey = `foto-0${i}`;
    const fotoEl = artikel.querySelector(fotoKey);
    if (fotoEl?.textContent?.trim()) {
      const filename = fotoEl.textContent.trim();
      // Convert to Supabase Storage URL
      const imageUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${filename}`;
      photos.push(imageUrl);
    }
  }
  return photos;
}

function extractColor(artikel: any) {
  return {
    code: artikel.querySelector('kleur')?.textContent || '',
    label: artikel.querySelector('kleur-oms')?.textContent || '',
    labelSupplier: artikel.querySelector('kleur-oms-lev')?.textContent || '',
    web: artikel.querySelector('kleur-web')?.textContent || '',
    filter: artikel.querySelector('webfilter-kleur')?.textContent || '',
  };
}

function extractAttributes(artikel: any) {
  const attrs: any = {};
  
  // Extract attribute names and values (attribuut-nm-1 through attribuut-nm-20)
  for (let i = 1; i <= 20; i++) {
    const attrName = artikel.querySelector(`attribuut-nm-${i}`)?.textContent?.trim();
    const attrValueOms = artikel.querySelector(`attribuut-waarde-oms-${i}`)?.textContent?.trim();
    const attrValue = artikel.querySelector(`attribuut-waarde-${i}`)?.textContent?.trim();
    
    if (attrName && attrValue && attrValue !== '000') {
      // Use the readable description (oms) if available, otherwise fallback to code
      const finalValue = attrValueOms || attrValue;
      
      // Skip codes like '001', '002', etc. (3 or less digits) - these are not descriptive
      // But allow actual descriptive values even if they contain numbers
      const isNumericCode = /^\d{1,3}$/.test(finalValue);
      
      if (!isNumericCode) {
        attrs[attrName] = finalValue;
      }
    }
  }
  
  return attrs;
}

function extractCategories(artikel: any) {
  const categories = [];
  
  for (let i = 1; i <= 8; i++) {
    const groupId = artikel.querySelector(`webshop-groep-${i}`)?.textContent?.trim();
    const groupDesc = artikel.querySelector(`wgp-omschrijving-${i}`)?.textContent?.trim();
    
    if (groupId && groupId !== '0000' && groupDesc) {
      categories.push({
        id: groupId,
        name: groupDesc,
        level: i
      });
    }
  }
  
  return categories;
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

    console.log(`Processing article import: ${fileName}`);

    // ── XSD Validation Gate ───────────────────────────────────────
    // Validate XML structure before processing to catch malformed files early
    console.log(`Running XSD validation for ${fileName}...`);
    const { data: valResult, error: valError } = await supabase.functions.invoke('validate-inbound-xml', {
      body: { fileName, xmlContent, tenantId, strict: true },
    });

    if (valError) {
      console.error('XSD validation call failed:', valError);
      // Non-blocking: log but continue processing
    } else if (valResult && !valResult.valid) {
      const errorCount = valResult.stats?.xsd_errors ?? valResult.errors?.length ?? 0;
      console.error(`XSD validation FAILED: ${errorCount} errors found`);

      // Log rejection to changelog
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'XML_VALIDATION_REJECTED',
        description: `Artikel bestand '${fileName}' afgewezen door XSD validatie: ${errorCount} fouten gevonden.`,
        metadata: {
          fileName,
          fileType: valResult.fileType,
          errorCount,
          firstErrors: (valResult.errors || []).slice(0, 5),
        },
      });

      return new Response(
        JSON.stringify({
          error: 'XML validation failed',
          valid: false,
          errorCount,
          errors: (valResult.errors || []).slice(0, 20),
          message: `Bestand '${fileName}' voldoet niet aan het XSD schema. ${errorCount} fouten gevonden.`,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      console.log(`XSD validation PASSED for ${fileName} (${valResult?.itemCount} items, ${valResult?.stats?.xsd_warnings ?? 0} warnings)`);
    }

    // Parse XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/html');
    
    if (!doc) {
      throw new Error('Failed to parse XML');
    }

    const artikelen = doc.querySelectorAll('artikel');
    
    if (artikelen.length === 0) {
      throw new Error('No articles found in XML');
    }

    console.log(`Found ${artikelen.length} articles - starting background processing`);

    // Process articles in background to avoid timeout
    const processArticles = async () => {
      let processedCount = 0;
      let variantCount = 0;
      const changedProductIds = new Set<string>();
      const changedVariantIds = new Set<string>();

      // Process each article
      for (const artikel of (artikelen as any)) {
      try {
        // 1. Upsert Brand
        const merkNaam = artikel.querySelector('merk merknaam')?.textContent || '';
        let brandId = null;
        
        if (merkNaam) {
          const { data: brand } = await supabase
            .from('brands')
            .upsert({ name: merkNaam }, { onConflict: 'name' })
            .select()
            .single();
          brandId = brand?.id;
        }

        // 2. Upsert Supplier
        const leverancierNaam = artikel.querySelector('leverancier naam-leverancier')?.textContent || '';
        let supplierId = null;
        
        if (leverancierNaam) {
          const { data: supplier } = await supabase
            .from('suppliers')
            .upsert({ name: leverancierNaam }, { onConflict: 'name' })
            .select()
            .single();
          supplierId = supplier?.id;
        }

        // 3. Extract product data
        const sku = artikel.querySelector('artikelnummer')?.textContent || '';
        const title = artikel.querySelector('webshop-titel')?.textContent || '';
        const taxCode = artikel.querySelector('btw-code')?.textContent || '';
        const urlKey = artikel.querySelector('url-sleutel')?.textContent || null;
        const images = extractPhotos(artikel, supabaseUrl);
        const color = extractColor(artikel);
        const attributes = extractAttributes(artikel);
        const categories = extractCategories(artikel);
        
        // Extract additional product fields
        const costPrice = parsePrice(artikel.querySelector('kostprijs')?.textContent || '0');
        const discountPercentage = parsePrice(artikel.querySelector('kortings-percentage')?.textContent || '0');
        const internalDescription = artikel.querySelector('interne-omschrijving')?.textContent || null;
        const webshopText = artikel.querySelector('webshop-tekst')?.textContent || null;
        const webshopTextEn = artikel.querySelector('webshop-tekst-en')?.textContent || null;
        const metaTitle = artikel.querySelector('meta-titel-1')?.textContent || null;
        const metaKeywords = artikel.querySelector('meta-keywords-1')?.textContent || null;
        const metaDescription = artikel.querySelector('meta-oms-1')?.textContent || null;
        const planPeriod = artikel.querySelector('planperiode')?.textContent || null;
        const outletSale = artikel.querySelector('outlet-sale')?.textContent === '1';
        const isPromotion = artikel.querySelector('aanbieding')?.textContent === '1';
        const webshopDateStr = artikel.querySelector('webshopdatum')?.textContent || null;
        const webshopDate = webshopDateStr ? webshopDateStr : null;
        
        const articleGroupEl = artikel.querySelector('artikelgroep');
        const articleGroup = articleGroupEl ? {
          id: articleGroupEl.getAttribute('id') || '',
          description: articleGroupEl.querySelector('omschrijving')?.textContent || ''
        } : null;

        // 4. Check if product exists to detect new/changed products
        const { data: existingProduct } = await supabase
          .from('products')
          .select('id, title, images, attributes, categories, locked_fields, field_sources')
          .eq('sku', sku)
          .maybeSingle();

        // Get locked fields for this product
        const lockedFields: string[] = (existingProduct?.locked_fields as string[]) || [];

        // 5. Build product record, skipping locked fields and tracking sources
        const productRecord: any = {
          sku: sku,
          tenant_id: tenantId,
        };
        const fieldMap: Record<string, any> = {
          title, tax_code: taxCode, images, color, attributes, categories,
          url_key: urlKey, brand_id: brandId, supplier_id: supplierId,
          cost_price: costPrice, discount_percentage: discountPercentage,
          internal_description: internalDescription, webshop_text: webshopText,
          webshop_text_en: webshopTextEn, meta_title: metaTitle,
          meta_keywords: metaKeywords, meta_description: metaDescription,
          plan_period: planPeriod, article_group: articleGroup,
          outlet_sale: outletSale, is_promotion: isPromotion, webshop_date: webshopDate,
        };
        // Merge existing field_sources with new ones
        const existingSources = (existingProduct as any)?.field_sources || {};
        const fieldSources: Record<string, string> = { ...existingSources };
        for (const [field, value] of Object.entries(fieldMap)) {
          if (!lockedFields.includes(field)) {
            productRecord[field] = value;
            fieldSources[field] = 'modis';
          }
        }
        productRecord.field_sources = fieldSources;

        if (lockedFields.length > 0) {
          console.log(`Product ${sku}: skipping locked fields: ${lockedFields.join(', ')}`);
        }

        const { data: product, error: productError } = await supabase
          .from('products')
          .upsert(productRecord, { onConflict: 'sku' })
          .select()
          .single();

        if (productError) {
          console.error(`Error upserting product ${sku}:`, productError);
          continue;
        }

        // Track if product is new or has changes in images/attributes/categories
        if (!existingProduct || 
            JSON.stringify(existingProduct.images) !== JSON.stringify(images) ||
            JSON.stringify(existingProduct.attributes) !== JSON.stringify(attributes) ||
            JSON.stringify(existingProduct.categories) !== JSON.stringify(categories)) {
          changedProductIds.add(product.id);
        }

        // 6. Check and upsert Product Price
        const regularPrice = parsePrice(artikel.querySelector('verkoopprijs')?.textContent || '0');
        const listPrice = parsePrice(artikel.querySelector('lopende-verkoopprijs')?.textContent || '0');

        const { data: existingPrice } = await supabase
          .from('product_prices')
          .select('regular, list')
          .eq('product_id', product.id)
          .maybeSingle();

        await supabase
          .from('product_prices')
          .upsert({
            product_id: product.id,
            regular: regularPrice,
            list: listPrice,
            currency: 'EUR',
          }, { onConflict: 'product_id' });

        // Track if price changed
        if (!existingPrice || 
            existingPrice.regular !== regularPrice || 
            existingPrice.list !== listPrice) {
          changedProductIds.add(product.id);
        }

        // 7. Process Variants
        const maten = artikel.querySelectorAll('maten maat');
        const existingVariantIds: string[] = [];

        for (const maat of (maten as any)) {
          const maatId = maat.getAttribute('id') || '';
          const sizeLabel = maat.querySelector('maat-alfa')?.textContent || '';
          const maatWeb = maat.querySelector('maat-web')?.textContent || sizeLabel;
          const ean = maat.querySelector('ean-barcode')?.textContent || null;
          const active = maat.querySelector('maat-actief')?.textContent === '1';
          const allowBackorder = maat.querySelector('GIERMAN backorder-toestaan')?.textContent !== 'no';
          
          // Extract size_type from XML (maat-type element or attribute), default to 'regular'
          const validSizeTypes = ['regular', 'petite', 'plus', 'tall', 'big', 'maternity'];
          const rawSizeType = (maat.querySelector('maat-type')?.textContent || maat.getAttribute('type') || '').trim().toLowerCase();
          const sizeType = validSizeTypes.includes(rawSizeType) ? rawSizeType : 'regular';

          // Check if variant exists to detect changes
          const { data: existingVariant } = await supabase
            .from('variants')
            .select('id, ean, active, allow_backorder, size_type')
            .eq('product_id', product.id)
            .eq('maat_id', maatId)
            .maybeSingle();

          // Only update size_type from XML if it's explicitly set (not default fallback)
          // This preserves manually set size_type values from the UI
          const effectiveSizeType = rawSizeType && validSizeTypes.includes(rawSizeType)
            ? rawSizeType
            : (existingVariant?.size_type || 'regular');

          // Upsert Variant
          const { data: variant, error: variantError } = await supabase
            .from('variants')
            .upsert({
              product_id: product.id,
              maat_id: maatId,
              size_label: sizeLabel,
              maat_web: maatWeb,
              ean: ean,
              active: active,
              allow_backorder: allowBackorder,
              size_type: effectiveSizeType,
            }, { onConflict: 'product_id,maat_id' })
            .select()
            .single();

          if (variantError) {
            console.error(`Error upserting variant ${maatId}:`, variantError);
            continue;
          }

          existingVariantIds.push(variant.id);

          // Track if variant attributes changed (EAN, active status, size_type)
          if (!existingVariant || 
              existingVariant.ean !== ean || 
              existingVariant.active !== active ||
              existingVariant.allow_backorder !== allowBackorder ||
              existingVariant.size_type !== effectiveSizeType) {
            changedVariantIds.add(variant.id);
          }

          // Check and upsert Stock Total
          const totalQty = parseInteger(maat.querySelector('voorraad totaal-aantal')?.textContent || '0');
          
          const { data: existingStock } = await supabase
            .from('stock_totals')
            .select('qty')
            .eq('variant_id', variant.id)
            .maybeSingle();

          await supabase
            .from('stock_totals')
            .upsert({
              variant_id: variant.id,
              qty: totalQty,
            }, { onConflict: 'variant_id' });

          // Track if stock changed
          if (!existingStock || existingStock.qty !== totalQty) {
            changedVariantIds.add(variant.id);
          }

          // Delete old stock_by_store
          await supabase
            .from('stock_by_store')
            .delete()
            .eq('variant_id', variant.id);

          // Insert new stock_by_store
          const filialen = maat.querySelectorAll('voorraad filialen filiaal');
          for (const filiaal of (filialen as any)) {
            const storeId = filiaal.getAttribute('id') || '';
            const qty = parseInteger(filiaal.querySelector('Aantal')?.textContent || '0');

            await supabase
              .from('stock_by_store')
              .insert({
                variant_id: variant.id,
                store_id: storeId,
                qty: qty,
              });
          }

          variantCount++;
        }

        // Soft-delete variants not in XML
        if (existingVariantIds.length > 0) {
          await supabase
            .from('variants')
            .update({ active: false })
            .eq('product_id', product.id)
            .not('id', 'in', `(${existingVariantIds.join(',')})`);
        }

        processedCount++;
      } catch (error) {
        console.error(`Error processing article:`, error);
      }
    }

      console.log(`Import complete: ${processedCount} products, ${variantCount} variants`);
      console.log(`Changed: ${changedProductIds.size} products, ${changedVariantIds.size} variants`);
      
      // Create sync job if there are changes
      if (changedProductIds.size > 0 || changedVariantIds.size > 0) {
        const jobPayload: any = {};
        
        if (changedProductIds.size > 0) {
          jobPayload.productIds = Array.from(changedProductIds);
        }
        
        if (changedVariantIds.size > 0) {
          jobPayload.variantIds = Array.from(changedVariantIds);
        }

        const { error: jobError } = await supabase
          .from('jobs')
          .insert({
            type: 'SYNC_TO_WOO',
            state: 'ready',
            payload: jobPayload,
            tenant_id: tenantId,
          });

        if (jobError) {
          console.error('Error creating sync job:', jobError);
        } else {
          console.log(`Created SYNC_TO_WOO job for ${changedProductIds.size} products and ${changedVariantIds.size} variants`);
        }
      }
      
      // Add changelog entry
      if (tenantId) {
        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'PRODUCTS_IMPORTED',
          description: `${processedCount} producten geïmporteerd van ${fileName}. ${changedProductIds.size} producten en ${changedVariantIds.size} varianten gewijzigd.`,
          metadata: {
            productCount: processedCount,
            variantCount: variantCount,
            changedProducts: changedProductIds.size,
            changedVariants: changedVariantIds.size,
            fileName: fileName
          }
        });
      }
    };

    // Start background processing (don't await)
    processArticles().catch(err => console.error('Background processing error:', err));

    // Return immediate response
    return new Response(
      JSON.stringify({
        success: true,
        message: `Started processing ${artikelen.length} articles from ${fileName}`,
        articles: artikelen.length,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in process-articles:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
