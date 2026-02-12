import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ParentProduct {
  sku: string;
  title: string;
  shortDescription: string;
  regularPrice: number | null;
  salePrice: number | null;
  categories: string[];
  brand: string;
  images: string[];
  attributes: Record<string, string>;
}

interface Variation {
  sku: string;
  parentSku: string;
  sizeLabel: string;
  stock: number;
  ean: string;
  regularPrice: number | null;
  salePrice: number | null;
}

function parsePrice(val: string): number | null {
  if (!val || val.trim() === '') return null;
  const cleaned = val.replace(',', '.');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) || parsed === 0 ? null : parsed;
}

function parseSemicolonCSV(text: string): string[][] {
  const lines = text.split('\n');
  const result: string[][] = [];
  
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ';' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);
    result.push(fields);
  }
  
  return result;
}

function extractSizeFromName(name: string): string {
  const match = name.match(/ - ([^-]+)$/);
  return match ? match[1].trim() : '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const tenantSlug = body.tenant || 'kosterschoenmode';
    const storagePath = body.storagePath || 'import/products-totaal.csv';

    console.log(`Starting CSV import for tenant: ${tenantSlug}`);

    // Get tenant
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('slug', tenantSlug)
      .single();

    if (!tenant) throw new Error('Tenant not found');
    const tenantId = tenant.id;

    // Download CSV from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('order-exports')
      .download(storagePath);

    if (downloadError || !fileData) {
      throw new Error(`Failed to download CSV: ${downloadError?.message}`);
    }

    const csvText = await fileData.text();
    const rows = parseSemicolonCSV(csvText);
    
    if (rows.length < 2) throw new Error('CSV has no data rows');
    
    const headers = rows[0];
    console.log(`Parsed ${rows.length - 1} CSV rows, ${headers.length} columns`);
    
    // Find column indices
    const colIdx = (name: string) => headers.findIndex(h => h.toLowerCase().trim() === name.toLowerCase().trim());
    const typeIdx = colIdx('Type');
    const skuIdx = colIdx('SKU');
    const nameIdx = colIdx('name');
    const shortDescIdx = colIdx('Short description');
    const salePriceIdx = colIdx('Sale price');
    const regularPriceIdx = colIdx('Regular price');
    const categoriesIdx = colIdx('Categories');
    const brandsIdx = colIdx('Brands');
    const imagesIdx = colIdx('Images');
    const stockIdx = colIdx('Stock');
    const parentIdx = colIdx('Parent');
    const eanIdx = headers.findIndex(h => h.toLowerCase().includes('barcode') || h.toLowerCase().includes('_ywbc'));

    console.log(`Column indices: type=${typeIdx}, sku=${skuIdx}, name=${nameIdx}, price=${regularPriceIdx}, stock=${stockIdx}, parent=${parentIdx}, ean=${eanIdx}`);

    // Parse parents and variations
    const parents: ParentProduct[] = [];
    const variations: Variation[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const type = row[typeIdx]?.trim();
      const sku = row[skuIdx]?.trim();
      
      if (!sku) continue;

      if (type === 'variable') {
        // Parse attributes
        const attributes: Record<string, string> = {};
        for (let a = 1; a <= 20; a++) {
          const attrNameIdx = headers.findIndex(h => h === `Attribute ${a} name`);
          const attrValIdx = headers.findIndex(h => h === `Attribute ${a} value(s)`);
          if (attrNameIdx >= 0 && attrValIdx >= 0) {
            const attrName = row[attrNameIdx]?.trim();
            const attrVal = row[attrValIdx]?.trim();
            if (attrName && attrVal) {
              attributes[attrName] = attrVal;
            }
          }
        }

        const cats = row[categoriesIdx]?.trim();
        const images = row[imagesIdx]?.trim();

        parents.push({
          sku,
          title: row[nameIdx]?.trim() || sku,
          shortDescription: row[shortDescIdx]?.trim() || '',
          regularPrice: parsePrice(row[regularPriceIdx] || ''),
          salePrice: parsePrice(row[salePriceIdx] || ''),
          categories: cats ? cats.split('>').map((c: string) => c.trim()).filter(Boolean) : [],
          brand: row[brandsIdx]?.trim() || '',
          images: images ? images.split(',').map((i: string) => i.trim()).filter(Boolean) : [],
          attributes,
        });
      } else if (type === 'variation') {
        const parentSku = row[parentIdx]?.trim() || '';
        const name = row[nameIdx]?.trim() || '';
        const sizeLabel = extractSizeFromName(name);
        const ean = eanIdx >= 0 ? (row[eanIdx]?.trim() || '') : '';

        variations.push({
          sku,
          parentSku,
          sizeLabel,
          stock: parseInt(row[stockIdx] || '0') || 0,
          ean,
          regularPrice: parsePrice(row[regularPriceIdx] || ''),
          salePrice: parsePrice(row[salePriceIdx] || ''),
        });
      }
    }

    console.log(`Found ${parents.length} parent products, ${variations.length} variations`);

    // Get existing SKUs
    const existingSkus = new Set<string>();
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('sku')
        .eq('tenant_id', tenantId)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      data.forEach((p: any) => existingSkus.add(p.sku));
      if (data.length < 1000) break;
      offset += 1000;
    }

    console.log(`Existing products in DB: ${existingSkus.size}`);

    // Filter new parents only
    const newParents = parents.filter(p => !existingSkus.has(p.sku));
    console.log(`New products to import: ${newParents.length}`);

    if (newParents.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No new products to import',
        existing: existingSkus.size,
        csvParents: parents.length,
        csvVariations: variations.length,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get/create brands
    const uniqueBrands = [...new Set(newParents.map(p => p.brand).filter(Boolean))];
    const brandMap = new Map<string, string>();

    if (uniqueBrands.length > 0) {
      const { data: existingBrands } = await supabase.from('brands').select('id, name');
      existingBrands?.forEach((b: any) => brandMap.set(b.name, b.id));

      const missingBrands = uniqueBrands.filter(b => !brandMap.has(b));
      if (missingBrands.length > 0) {
        const { data: created } = await supabase
          .from('brands')
          .insert(missingBrands.map(name => ({ name })))
          .select('id, name');
        created?.forEach((b: any) => brandMap.set(b.name, b.id));
        console.log(`Created ${missingBrands.length} new brands`);
      }
    }

    // PHASE 1: Insert products in batches of 50
    const BATCH = 50;
    const skuToProductId = new Map<string, string>();
    let productsInserted = 0;

    for (let i = 0; i < newParents.length; i += BATCH) {
      const batch = newParents.slice(i, i + BATCH);
      const records = batch.map(p => ({
        tenant_id: tenantId,
        sku: p.sku,
        title: p.title,
        webshop_text: p.shortDescription || null,
        categories: p.categories,
        images: p.images,
        attributes: p.attributes,
        brand_id: p.brand ? brandMap.get(p.brand) || null : null,
      }));

      const { data: inserted, error } = await supabase
        .from('products')
        .insert(records)
        .select('id, sku');

      if (error) {
        console.error(`Failed batch ${i / BATCH + 1}:`, error.message);
        continue;
      }

      inserted?.forEach((p: any) => skuToProductId.set(p.sku, p.id));
      productsInserted += (inserted?.length || 0);
      console.log(`Inserted products batch ${Math.floor(i / BATCH) + 1}: ${inserted?.length || 0}`);
    }

    console.log(`Total products inserted: ${productsInserted}`);

    // PHASE 2: Insert prices
    const pricesToInsert: any[] = [];
    for (const parent of newParents) {
      const productId = skuToProductId.get(parent.sku);
      if (!productId) continue;

      let regular = parent.regularPrice;
      let sale = parent.salePrice;

      // If no price on parent, get from first variation
      if (!regular && !sale) {
        const firstVar = variations.find(v => v.parentSku === parent.sku);
        if (firstVar) {
          regular = firstVar.regularPrice;
          sale = firstVar.salePrice;
        }
      }

      pricesToInsert.push({
        product_id: productId,
        regular: regular,
        list: sale,
        currency: 'EUR',
      });
    }

    let pricesInserted = 0;
    for (let i = 0; i < pricesToInsert.length; i += BATCH) {
      const batch = pricesToInsert.slice(i, i + BATCH);
      const { error } = await supabase.from('product_prices').insert(batch);
      if (error) {
        console.error(`Failed prices batch:`, error.message);
      } else {
        pricesInserted += batch.length;
      }
    }

    // PHASE 3: Insert variants
    const newParentSkus = new Set(newParents.map(p => p.sku));
    const variationsForNew = variations.filter(v => newParentSkus.has(v.parentSku));
    
    const skuToVariantId = new Map<string, string>();
    let variantsInserted = 0;

    for (let i = 0; i < variationsForNew.length; i += BATCH) {
      const batch = variationsForNew.slice(i, i + BATCH);
      const records = batch.map(v => ({
        product_id: skuToProductId.get(v.parentSku)!,
        maat_id: v.sku,
        size_label: v.sizeLabel || v.sku,
        ean: v.ean || null,
        active: true,
      })).filter(r => r.product_id);

      const { data: inserted, error } = await supabase
        .from('variants')
        .insert(records)
        .select('id, maat_id');

      if (error) {
        console.error(`Failed variants batch:`, error.message);
        continue;
      }

      inserted?.forEach((v: any) => skuToVariantId.set(v.maat_id, v.id));
      variantsInserted += (inserted?.length || 0);
    }

    console.log(`Variants inserted: ${variantsInserted}`);

    // PHASE 4: Insert stock totals
    let stockInserted = 0;
    const stockRecords: any[] = [];
    
    for (const v of variationsForNew) {
      const variantId = skuToVariantId.get(v.sku);
      if (!variantId) continue;
      stockRecords.push({ variant_id: variantId, qty: v.stock });
    }

    for (let i = 0; i < stockRecords.length; i += BATCH) {
      const batch = stockRecords.slice(i, i + BATCH);
      const { error } = await supabase.from('stock_totals').insert(batch);
      if (error) {
        console.error(`Failed stock batch:`, error.message);
      } else {
        stockInserted += batch.length;
      }
    }

    const summary = {
      success: true,
      csvParents: parents.length,
      csvVariations: variations.length,
      existingProducts: existingSkus.size,
      newProductsFound: newParents.length,
      productsInserted,
      pricesInserted,
      variantsInserted,
      stockInserted,
      brandsCreated: uniqueBrands.filter(b => !brandMap.has(b)).length,
    };

    console.log('Import complete:', JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Import error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
