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
  colorArticle: string;
  colorWebshop: string;
}

interface VariationRow {
  sku: string;
  parentSku: string;
  shortMaatId: string;
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

function parseAllRows(rows: string[][], headers: string[]) {
  const col = (name: string) => headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const typeIdx = col('Type');
  const skuIdx = col('SKU');
  const nameIdx = col('name');
  const shortDescIdx = col('Short description');
  const salePriceIdx = col('Sale price');
  const regularPriceIdx = col('Regular price');
  const categoriesIdx = col('Categories');
  const brandsIdx = col('Brands');
  const imagesIdx = col('Images');
  const stockIdx = col('Stock');
  const parentIdx = col('Parent');
  const eanIdx = headers.findIndex(h => h.includes('_ywbc_barcode'));
  const colorArticleIdx = col('Color-article');
  const colorWebshopIdx = col('Color-webshop');
  const maatAlfaIdx = col('Maat-alfa');

  const parents: ParentProduct[] = [];
  const variations: VariationRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const type = row[typeIdx]?.trim();
    const sku = row[skuIdx]?.trim();
    if (!sku) continue;

    if (type === 'variable') {
      const attributes: Record<string, string> = {};
      for (let a = 1; a <= 20; a++) {
        const ni = headers.findIndex(h => h === `Attribute ${a} name`);
        const vi = headers.findIndex(h => h === `Attribute ${a} value(s)`);
        if (ni >= 0 && vi >= 0) {
          const n = row[ni]?.trim();
          const v = row[vi]?.trim();
          if (n && v) attributes[n] = v;
        }
      }

      const cats = row[categoriesIdx]?.trim() || '';
      const imgs = row[imagesIdx]?.trim() || '';

      parents.push({
        sku,
        title: row[nameIdx]?.trim() || sku,
        shortDescription: row[shortDescIdx]?.trim() || '',
        regularPrice: parsePrice(row[regularPriceIdx] || ''),
        salePrice: parsePrice(row[salePriceIdx] || ''),
        categories: cats ? cats.split('>').map(c => c.trim()).filter(Boolean) : [],
        brand: row[brandsIdx]?.trim() || '',
        images: imgs ? imgs.split(';').map(i => i.trim()).filter(Boolean) : [],
        attributes,
        colorArticle: colorArticleIdx >= 0 ? (row[colorArticleIdx]?.trim() || '') : '',
        colorWebshop: colorWebshopIdx >= 0 ? (row[colorWebshopIdx]?.trim() || '') : '',
      });
    } else if (type === 'variation') {
      const maat = maatAlfaIdx >= 0 ? (row[maatAlfaIdx]?.trim() || '') : '';
      // Extract short maat_id from full variation SKU (e.g. "109609003000-011390" -> "011390")
      const shortMaatId = sku.includes('-') ? sku.split('-').pop()! : sku;
      variations.push({
        sku,
        parentSku: row[parentIdx]?.trim() || '',
        shortMaatId,
        sizeLabel: maat || shortMaatId,
        stock: parseInt(row[stockIdx] || '0') || 0,
        ean: eanIdx >= 0 ? (row[eanIdx]?.trim() || '') : '',
        regularPrice: parsePrice(row[regularPriceIdx] || ''),
        salePrice: parsePrice(row[salePriceIdx] || ''),
      });
    }
  }

  return { parents, variations };
}

function validateCSV(headers: string[], rows: string[][]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const requiredHeaders = ['Type', 'SKU', 'name'];
  for (const h of requiredHeaders) {
    if (!headers.some(hdr => hdr.trim().toLowerCase() === h.toLowerCase())) {
      errors.push(`Ontbrekende verplichte kolom: "${h}"`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  const typeIdx = headers.findIndex(h => h.trim().toLowerCase() === 'type');
  const skuIdx = headers.findIndex(h => h.trim().toLowerCase() === 'sku');
  let emptySkus = 0;
  let unknownTypes = 0;
  const validTypes = new Set(['variable', 'variation', 'simple', '']);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const type = row[typeIdx]?.trim() || '';
    const sku = row[skuIdx]?.trim() || '';
    if (!sku) { emptySkus++; continue; }
    if (type && !validTypes.has(type)) unknownTypes++;
  }

  if (emptySkus > 0) errors.push(`${emptySkus} rijen zonder SKU`);
  if (unknownTypes > 0) errors.push(`${unknownTypes} rijen met onbekend type`);

  return { valid: errors.length === 0 || emptySkus < rows.length, errors };
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
    const storagePath = body.storagePath || 'import/products-test.csv';
    const mode = body.mode || 'upsert';
    const offset = body.offset || 0;
    const chunkSize = body.chunkSize || 200; // parents per invocation

    console.log(`[import-modis-csv] Starting. tenant=${tenantSlug}, path=${storagePath}, mode=${mode}, offset=${offset}, chunk=${chunkSize}`);

    // Get tenant
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');
    const tenantId = tenant.id;

    // Download and parse CSV
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('order-exports').download(storagePath);
    if (downloadError || !fileData) throw new Error(`Download failed: ${downloadError?.message}`);

    const csvText = await fileData.text();
    const rows = parseSemicolonCSV(csvText);
    if (rows.length < 2) throw new Error('CSV has no data rows');

    const headers = rows[0];

    // === VALIDATION STEP ===
    const validation = validateCSV(headers, rows);
    if (validation.errors.length > 0) {
      console.warn(`[import-modis-csv] Validation warnings: ${validation.errors.join('; ')}`);
    }
    if (!validation.valid) {
      const filename = storagePath.split('/').pop() || storagePath;
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'PRODUCT_CSV_IMPORT',
        description: `CSV validatie mislukt voor ${filename}: ${validation.errors.join(', ')}`,
        metadata: { filename, validation_errors: validation.errors, valid: false },
      });
      throw new Error(`CSV validation failed: ${validation.errors.join(', ')}`);
    }

    const { parents: allParents, variations: allVariations } = parseAllRows(rows, headers);

    console.log(`[import-modis-csv] Total parsed: ${allParents.length} parents, ${allVariations.length} variations`);

    // Slice parents for this chunk
    const chunkParents = allParents.slice(offset, offset + chunkSize);
    if (chunkParents.length === 0) {
      return new Response(JSON.stringify({
        success: true, complete: true, message: 'No more parents to process',
        totalParents: allParents.length, offset,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get variations belonging to this chunk's parents
    const chunkParentSkus = new Set(chunkParents.map(p => p.sku));
    const chunkVariations = allVariations.filter(v => chunkParentSkus.has(v.parentSku));

    console.log(`[import-modis-csv] Chunk ${offset}-${offset + chunkParents.length}: ${chunkParents.length} parents, ${chunkVariations.length} variations`);

    // Pre-fetch existing products by SKU (including locked_fields and field_sources)
    const skuList = chunkParents.map(p => p.sku);
    const existingProducts = new Map<string, { id: string; locked_fields: string[]; field_sources: Record<string, string> }>();
    for (let i = 0; i < skuList.length; i += 200) {
      const batch = skuList.slice(i, i + 200);
      const { data } = await supabase
        .from('products').select('id, sku, locked_fields, field_sources').eq('tenant_id', tenantId).in('sku', batch);
      data?.forEach((p: any) => existingProducts.set(p.sku, { id: p.id, locked_fields: p.locked_fields || [], field_sources: p.field_sources || {} }));
    }

    // Pre-fetch existing variants
    const varSkus = chunkVariations.map(v => v.shortMaatId);
    const existingVariants = new Map<string, { id: string; product_id: string }>();
    for (let i = 0; i < varSkus.length; i += 200) {
      const batch = varSkus.slice(i, i + 200);
      const { data } = await supabase
        .from('variants').select('id, maat_id, product_id').in('maat_id', batch);
      data?.forEach((v: any) => existingVariants.set(`${v.product_id}:${v.maat_id}`, v));
    }

    // Get/create brands
    const uniqueBrands = [...new Set(chunkParents.map(p => p.brand).filter(Boolean))];
    const brandMap = new Map<string, string>();
    if (uniqueBrands.length > 0) {
      const { data: existingBrands } = await supabase.from('brands').select('id, name');
      existingBrands?.forEach((b: any) => brandMap.set(b.name, b.id));
      const missing = uniqueBrands.filter(b => !brandMap.has(b));
      if (missing.length > 0) {
        const { data: created } = await supabase
          .from('brands').insert(missing.map(name => ({ name }))).select('id, name');
        created?.forEach((b: any) => brandMap.set(b.name, b.id));
      }
    }

    const stats = { productsInserted: 0, productsUpdated: 0, variantsInserted: 0, variantsUpdated: 0, pricesUpserted: 0, stockUpserted: 0 };
    const BATCH = 50;
    const skuToProductId = new Map<string, string>();
    existingProducts.forEach((p, sku) => skuToProductId.set(sku, p.id));

    // Track new SKUs for changelog
    const newSkus: { sku: string; title: string; brand: string }[] = [];

    // PHASE 1: Upsert products
    const toInsert: any[] = [];
    const toUpdate: { id: string; data: any }[] = [];

    for (const p of chunkParents) {
      const color = (p.colorArticle || p.colorWebshop) ? { article: p.colorArticle, webshop: p.colorWebshop } : null;
      const importFields: Record<string, any> = {
        title: p.title,
        webshop_text: p.shortDescription || null,
        categories: p.categories,
        images: p.images,
        attributes: p.attributes,
        brand_id: p.brand ? brandMap.get(p.brand) || null : null,
        color,
      };

      const existing = existingProducts.get(p.sku);
      if (existing) {
        if (mode === 'upsert') {
          const locked = existing.locked_fields || [];
          const fieldSources: Record<string, string> = { ...existing.field_sources };
          const filteredRecord: Record<string, any> = { tenant_id: tenantId, sku: p.sku };
          for (const [field, value] of Object.entries(importFields)) {
            if (!locked.includes(field)) {
              filteredRecord[field] = value;
              fieldSources[field] = 'woocommerce-csv';
            }
          }
          filteredRecord.field_sources = fieldSources;
          if (locked.length > 0) {
            console.log(`[import-modis-csv] Product ${p.sku}: skipping locked fields: ${locked.join(', ')}`);
          }
          toUpdate.push({ id: existing.id, data: filteredRecord });
        }
      } else {
        // New product — set all sources
        const fieldSources: Record<string, string> = {};
        for (const field of Object.keys(importFields)) {
          fieldSources[field] = 'woocommerce-csv';
        }
        toInsert.push({ tenant_id: tenantId, sku: p.sku, ...importFields, field_sources: fieldSources });
        newSkus.push({ sku: p.sku, title: p.title, brand: p.brand });
      }
    }

    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      const { data: inserted, error } = await supabase
        .from('products').insert(batch).select('id, sku');
      if (error) { console.error('Insert products error:', error.message); continue; }
      inserted?.forEach((p: any) => skuToProductId.set(p.sku, p.id));
      stats.productsInserted += inserted?.length || 0;
    }

    for (const item of toUpdate) {
      const { tenant_id: _t, sku: _s, ...updateData } = item.data;
      const { error } = await supabase.from('products').update(updateData).eq('id', item.id);
      if (error) { console.error(`Update product ${item.id}:`, error.message); continue; }
      stats.productsUpdated++;
    }

    // PHASE 2: Upsert prices
    for (let i = 0; i < chunkParents.length; i += BATCH) {
      const batch = chunkParents.slice(i, i + BATCH);
      const records = batch.map(p => {
        const productId = skuToProductId.get(p.sku);
        if (!productId) return null;
        let regular = p.regularPrice;
        let sale = p.salePrice;
        if (!regular && !sale) {
          const firstVar = chunkVariations.find(v => v.parentSku === p.sku);
          if (firstVar) { regular = firstVar.regularPrice; sale = firstVar.salePrice; }
        }
        return { product_id: productId, regular, list: sale, currency: 'EUR' };
      }).filter(Boolean);

      if (records.length > 0) {
        const { error } = await supabase
          .from('product_prices').upsert(records as any[], { onConflict: 'product_id' });
        if (error) console.error('Upsert prices:', error.message);
        else stats.pricesUpserted += records.length;
      }
    }

    // PHASE 3: Upsert variants
    const varInsert: any[] = [];
    const varUpdate: { id: string; data: any }[] = [];

    for (const v of chunkVariations) {
      const productId = skuToProductId.get(v.parentSku);
      if (!productId) continue;

      const compositeKey = `${productId}:${v.shortMaatId}`;
      const existing = existingVariants.get(compositeKey);
      const record = {
        product_id: productId,
        maat_id: v.shortMaatId,
        size_label: v.sizeLabel,
        ean: v.ean || null,
        active: true,
      };

      if (existing) {
        if (mode === 'upsert') {
          varUpdate.push({ id: existing.id, data: { size_label: v.sizeLabel, ean: v.ean || null } });
        }
      } else {
        varInsert.push(record);
      }
    }

    const skuToVariantId = new Map<string, string>();
    existingVariants.forEach((v, compositeKey) => skuToVariantId.set(compositeKey, v.id));

    for (let i = 0; i < varInsert.length; i += BATCH) {
      const batch = varInsert.slice(i, i + BATCH);
      const { data: inserted, error } = await supabase
        .from('variants').upsert(batch, { onConflict: 'product_id,maat_id' }).select('id, maat_id, product_id');
      if (error) { console.error('Upsert variants:', error.message); continue; }
      inserted?.forEach((v: any) => {
        skuToVariantId.set(`${v.product_id}:${v.maat_id}`, v.id);
      });
      stats.variantsInserted += inserted?.length || 0;
    }

    for (const item of varUpdate) {
      const { error } = await supabase.from('variants').update(item.data).eq('id', item.id);
      if (!error) stats.variantsUpdated++;
    }

    // PHASE 4: Upsert stock
    const stockRecords: any[] = [];
    for (const v of chunkVariations) {
      const productId = skuToProductId.get(v.parentSku);
      if (!productId) continue;
      const compositeKey = `${productId}:${v.shortMaatId}`;
      const variantId = skuToVariantId.get(compositeKey);
      if (!variantId) continue;
      stockRecords.push({ variant_id: variantId, qty: v.stock });
    }

    for (let i = 0; i < stockRecords.length; i += BATCH) {
      const batch = stockRecords.slice(i, i + BATCH);
      const { error } = await supabase
        .from('stock_totals').upsert(batch, { onConflict: 'variant_id' });
      if (error) console.error('Upsert stock:', error.message);
      else stats.stockUpserted += batch.length;
    }

    // === LOG NEW SKUs TO CHANGELOG ===
    if (newSkus.length > 0) {
      const filename = storagePath.split('/').pop() || storagePath;
      const skuSummary = newSkus.map(s => `${s.sku} (${s.brand ? s.brand + ' - ' : ''}${s.title})`);
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'NEW_PRODUCTS_DETECTED',
        description: `${newSkus.length} nieuwe SKU('s) gedetecteerd in ${filename}: ${skuSummary.join(', ')}`,
        metadata: {
          filename,
          new_skus: newSkus,
          count: newSkus.length,
        },
      });
      console.log(`[import-modis-csv] Logged ${newSkus.length} new SKUs to changelog`);
    }

    const nextOffset = offset + chunkParents.length;
    const hasMore = nextOffset < allParents.length;

    const summary = {
      success: true,
      complete: !hasMore,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      mode,
      totalParents: allParents.length,
      totalVariations: allVariations.length,
      chunkProcessed: chunkParents.length,
      newSkus: newSkus.map(s => s.sku),
      validationWarnings: validation.errors,
      ...stats,
    };

    console.log('[import-modis-csv] Chunk complete:', JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[import-modis-csv] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
