import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
import { SftpClient } from "../_shared/sftp-client.ts";

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

function extractPhotos(artikel: any): string[] {
  const photos: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const fotoKey = `foto-0${i}`;
    const fotoEl = artikel.querySelector(fotoKey);
    if (fotoEl?.textContent?.trim()) {
      photos.push(fotoEl.textContent.trim());
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { filename, sourcePath } = await req.json();
    
    if (!filename || !sourcePath) {
      return new Response(
        JSON.stringify({ error: 'Missing filename or sourcePath' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing article import: ${filename}`);

    // Get SFTP config from database
    const { data: configData, error: configError } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'sftp')
      .single();

    if (configError || !configData) {
      throw new Error('SFTP configuration not found');
    }

    const sftpConfig = configData.value;
    const privateKey = Deno.env.get('SFTP_PRIVATE_KEY');
    
    if (!privateKey) {
      throw new Error('SFTP_PRIVATE_KEY not configured');
    }

    // Connect to SFTP and download file
    const sftpClient = new SftpClient();
    await sftpClient.connect({
      host: sftpConfig.host,
      port: sftpConfig.port,
      username: sftpConfig.username,
      privateKey: privateKey,
    });

    const filePath = `${sourcePath}/${filename}`;
    const processingPath = `${sourcePath}/../processing/${filename}`;
    
    // Move to processing directory
    await sftpClient.moveFile(filePath, processingPath);
    
    // Download file content
    const xmlContent = await sftpClient.downloadFile(processingPath);
    
    // Parse XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/xml');
    
    if (!doc) {
      throw new Error('Failed to parse XML');
    }

    const artikelen = doc.querySelectorAll('artikel');
    
    if (artikelen.length === 0) {
      throw new Error('No articles found in XML');
    }

    console.log(`Processing ${artikelen.length} articles`);

    let processedCount = 0;
    let variantCount = 0;

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
        const images = extractPhotos(artikel);
        const color = extractColor(artikel);

        // 4. Upsert Product
        const { data: product, error: productError } = await supabase
          .from('products')
          .upsert({
            sku: sku,
            title: title,
            tax_code: taxCode,
            images: images,
            color: color,
            url_key: urlKey,
            brand_id: brandId,
            supplier_id: supplierId,
          }, { onConflict: 'sku' })
          .select()
          .single();

        if (productError) {
          console.error(`Error upserting product ${sku}:`, productError);
          continue;
        }

        // 5. Upsert Product Price
        const regularPrice = parsePrice(artikel.querySelector('verkoopprijs')?.textContent || '0');
        const listPrice = parsePrice(artikel.querySelector('lopende-verkoopprijs')?.textContent || '0');

        await supabase
          .from('product_prices')
          .upsert({
            product_id: product.id,
            regular: regularPrice,
            list: listPrice,
            currency: 'EUR',
          }, { onConflict: 'product_id' });

        // 6. Process Variants
        const maten = artikel.querySelectorAll('maten maat');
        const existingVariantIds: string[] = [];

        for (const maat of (maten as any)) {
          const maatId = maat.getAttribute('id') || '';
          const sizeLabel = maat.querySelector('maat-alfa')?.textContent || '';
          const ean = maat.querySelector('ean-barcode')?.textContent || null;
          const active = maat.querySelector('maat-actief')?.textContent === '1';

          // Upsert Variant
          const { data: variant, error: variantError } = await supabase
            .from('variants')
            .upsert({
              product_id: product.id,
              maat_id: maatId,
              size_label: sizeLabel,
              ean: ean,
              active: active,
            }, { onConflict: 'product_id,maat_id' })
            .select()
            .single();

          if (variantError) {
            console.error(`Error upserting variant ${maatId}:`, variantError);
            continue;
          }

          existingVariantIds.push(variant.id);

          // Upsert Stock Total
          const totalQty = parseInteger(maat.querySelector('voorraad totaal-aantal')?.textContent || '0');
          
          await supabase
            .from('stock_totals')
            .upsert({
              variant_id: variant.id,
              qty: totalQty,
            }, { onConflict: 'variant_id' });

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

    // Move file to archive
    const now = new Date();
    const archiveFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const archivePath = `${sourcePath}/../archive/${archiveFolder}/${filename}`;
    
    await sftpClient.moveFile(processingPath, archivePath);
    await sftpClient.disconnect();

    console.log(`Import complete: ${processedCount} products, ${variantCount} variants`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: processedCount,
        variants: variantCount,
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
