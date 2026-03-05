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
  isSale: boolean;
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

/**
 * Normalize and validate a single image URL/path.
 * - Strips whitespace and quotes
 * - Removes legacy "modis/foto/" prefix (storage root is canonical)
 * - Converts backslashes to forward slashes
 * - Rejects data-URIs, empty strings, and obviously broken paths
 * - Returns null for invalid entries
 */
function normalizeImagePath(raw: string): string | null {
  let path = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!path || path.length < 3) return null;
  // Reject data-URIs (base64 blobs shouldn't be stored as image paths)
  if (path.startsWith('data:')) return null;
  // Normalize separators
  path = path.replace(/\\/g, '/');
  // Strip legacy subdirectory prefix (case-insensitive)
  path = path.replace(/^modis\/foto\//i, '');
  // Strip leading slash
  path = path.replace(/^\/+/, '');
  // Must have a recognizable image extension or be a URL
  const isUrl = path.startsWith('http://') || path.startsWith('https://');
  if (!isUrl) {
    const hasImageExt = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)$/i.test(path);
    if (!hasImageExt) return null;
  }
  return path;
}

function normalizeHeader(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[-_\s]+/g, " ")        // Normalize separators to single space
    .trim();
}

function findColumnIndex(headers: string[], possibleNames: string[]): number {
  const normalizedHeaders = headers.map(h => h ? normalizeHeader(String(h)) : "");
  const normalizedNames = possibleNames.map(normalizeHeader);

  // Priority 1: Exact match
  for (const name of normalizedNames) {
    const idx = normalizedHeaders.indexOf(name);
    if (idx !== -1) return idx;
  }
  // Priority 2: Starts with
  for (const name of normalizedNames) {
    const idx = normalizedHeaders.findIndex(h => h.startsWith(name));
    if (idx !== -1) return idx;
  }
  // Priority 3: Contains
  for (const name of normalizedNames) {
    const idx = normalizedHeaders.findIndex(h => h.includes(name));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseAllRows(rows: string[][], headers: string[]) {
  const col = (name: string) => headers.findIndex(h => normalizeHeader(h) === normalizeHeader(name));
  const flexCol = (possibleNames: string[]) => findColumnIndex(headers, possibleNames);

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
  // Attribute 21 has header "Attribute 21 Color-webshop" (single column, not name/value pair)
  const attr21Idx = headers.findIndex(h => normalizeHeader(h).includes('attribute 21'));
  // Legacy dedicated Color-webshop column
  const colorWebshopIdx = col('Color-webshop');
  // Attribute 22 = shoe type, Attribute 23 = (extra), Attribute 24 = sale flag
  const attr22Idx = headers.findIndex(h => h.trim() === 'Attribute 22');
  const attr23Idx = headers.findIndex(h => h.trim() === 'Attribute 23');
  const attr24Idx = headers.findIndex(h => h.trim() === 'Attribute 24');
  const maatAlfaIdx = flexCol(['Maat-alfa', 'Maat alfa', 'maat', 'size']);

  console.log(`[parseAllRows] Column detection: maatAlfaIdx=${maatAlfaIdx} (header: "${maatAlfaIdx >= 0 ? headers[maatAlfaIdx] : 'NOT FOUND'}")`);

  const parentMap = new Map<string, ParentProduct>();
  const variations: VariationRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const type = row[typeIdx]?.trim();
    const sku = row[skuIdx]?.trim();
    if (!sku) continue;

    if (type === 'variable') {
      const attributes: Record<string, string> = {};
      for (let a = 1; a <= 24; a++) {
        const ni = headers.findIndex(h => h === `Attribute ${a} name`);
        const vi = headers.findIndex(h => h === `Attribute ${a} value(s)`);
        if (ni >= 0 && vi >= 0) {
          const n = row[ni]?.trim();
          const v = row[vi]?.trim();
          if (n && v) attributes[n] = v;
        }
      }

      const cats = row[categoriesIdx]?.trim() || '';
      const imgsRaw = row[imagesIdx]?.trim() || '';
      const imgsSplit = imgsRaw ? imgsRaw.split(';').map(i => i.trim()).filter(Boolean) : [];
      const normalizedImages = imgsSplit.map(normalizeImagePath).filter((p): p is string => p !== null);
      if (imgsSplit.length > normalizedImages.length) {
        console.warn(`[import-modis-csv] Product ${sku}: dropped ${imgsSplit.length - normalizedImages.length} invalid image path(s)`);
      }

      // Extract special single-column attributes 21-24
      const attr21Val = attr21Idx >= 0 ? (row[attr21Idx]?.trim() || '') : '';
      const attr22Val = attr22Idx >= 0 ? (row[attr22Idx]?.trim() || '') : '';
      const attr23Val = attr23Idx >= 0 ? (row[attr23Idx]?.trim() || '') : '';
      const attr24Val = attr24Idx >= 0 ? (row[attr24Idx]?.trim() || '') : '';

      // Determine color-webshop: prefer dedicated column, then attr 21
      const csvColorWebshop = colorWebshopIdx >= 0 ? (row[colorWebshopIdx]?.trim() || '') : '';
      const finalColorWebshop = csvColorWebshop || attr21Val;

      // Attribute 22 = shoe type → store as attribute
      if (attr22Val) attributes['Type schoen'] = attr22Val;

      // Attribute 23 → store if non-empty (generic extra attribute)
      // (column header doesn't specify a name, skip if empty)

      // Attribute 24 = Sale flag: "Sale" / "Ja" / "yes" / "1" → true
      const saleRaw = attr24Val.toLowerCase();
      const isSale = ['sale', 'ja', 'yes', '1'].includes(saleRaw);

      const parent: ParentProduct = {
        sku,
        title: row[nameIdx]?.trim() || sku,
        shortDescription: row[shortDescIdx]?.trim() || '',
        regularPrice: parsePrice(row[regularPriceIdx] || ''),
        salePrice: parsePrice(row[salePriceIdx] || ''),
        categories: cats ? cats.split('>').map(c => c.trim()).filter(Boolean) : [],
        brand: row[brandsIdx]?.trim() || '',
        images: normalizedImages,
        attributes,
        colorArticle: colorArticleIdx >= 0 ? (row[colorArticleIdx]?.trim() || '') : '',
        colorWebshop: finalColorWebshop,
        isSale,
      };

      // Deduplicate: merge attributes, keep longest images/categories
      const existing = parentMap.get(sku);
      if (existing) {
        existing.attributes = { ...existing.attributes, ...parent.attributes };
        if (parent.images.length > existing.images.length) existing.images = parent.images;
        if (parent.categories.length > existing.categories.length) existing.categories = parent.categories;
        if (!existing.shortDescription && parent.shortDescription) existing.shortDescription = parent.shortDescription;
        if (!existing.regularPrice && parent.regularPrice) existing.regularPrice = parent.regularPrice;
        if (!existing.salePrice && parent.salePrice) existing.salePrice = parent.salePrice;
      } else {
        parentMap.set(sku, parent);
      }
    } else if (type === 'variation') {
      const maat = maatAlfaIdx >= 0 ? (row[maatAlfaIdx]?.trim() || '') : '';
      // Extract short maat_id from full variation SKU (e.g. "109609003000-011390" -> "011390")
      const shortMaatId = sku.includes('-') ? sku.split('-').pop()! : sku;
      const rawParent = row[parentIdx]?.trim() || '';
      // WooCommerce CSV exports may prefix parent with "id:" — strip it
      const parentSku = rawParent.replace(/^id:/i, '').trim();
      if (variations.length < 3) {
        console.log(`[parseAllRows] Sample variation: sku=${sku}, parentSku="${parentSku}" (raw="${rawParent}"), maat="${maat}", shortMaatId=${shortMaatId}`);
      }
      variations.push({
        sku,
        parentSku,
        shortMaatId,
        sizeLabel: maat || shortMaatId,
        stock: parseInt(row[stockIdx] || '0') || 0,
        ean: eanIdx >= 0 ? (row[eanIdx]?.trim() || '') : '',
        regularPrice: parsePrice(row[regularPriceIdx] || ''),
        salePrice: parsePrice(row[salePriceIdx] || ''),
      });
    }
  }

  const parents = Array.from(parentMap.values());
  console.log(`[parseAllRows] Deduplicated ${parentMap.size} unique parents from CSV rows`);
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
        is_promotion: p.isSale,
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
      if (error) {
        console.error('Insert products batch error:', error.message, '- retrying individually');
        // Retry individually to salvage what we can
        for (const item of batch) {
          const { data: single, error: singleErr } = await supabase
            .from('products').insert(item).select('id, sku');
          if (singleErr) { console.error(`Insert product ${item.sku} failed:`, singleErr.message); continue; }
          single?.forEach((p: any) => skuToProductId.set(p.sku, p.id));
          stats.productsInserted += single?.length || 0;
        }
        continue;
      }
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
    // Deduplicate by composite key (product_id:maat_id) to prevent
    // "ON CONFLICT DO UPDATE command cannot affect row a second time" errors
    const varInsert: any[] = [];
    const varUpdate: { id: string; data: any }[] = [];
    const seenInsertKeys = new Set<string>();

    let varSkipped = 0;
    let varDeduplicated = 0;
    for (const v of chunkVariations) {
      const productId = skuToProductId.get(v.parentSku);
      if (!productId) {
        varSkipped++;
        if (varSkipped <= 5) {
          console.warn(`[import-modis-csv] Variation ${v.sku} parentSku="${v.parentSku}" not found in skuToProductId map (${skuToProductId.size} entries)`);
        }
        continue;
      }

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
        // Deduplicate: skip if we already have this key in the insert batch
        if (seenInsertKeys.has(compositeKey)) {
          varDeduplicated++;
          continue;
        }
        seenInsertKeys.add(compositeKey);
        varInsert.push(record);
      }
    }

    if (varSkipped > 0) {
      console.warn(`[import-modis-csv] ${varSkipped} variations skipped (parentSku not found). Available parent SKUs: ${[...skuToProductId.keys()].slice(0, 10).join(', ')}`);
    }
    if (varDeduplicated > 0) {
      console.log(`[import-modis-csv] Deduplicated ${varDeduplicated} duplicate variation rows`);
    }
    console.log(`[import-modis-csv] Variants: ${varInsert.length} to insert, ${varUpdate.length} to update, ${varSkipped} skipped, ${varDeduplicated} deduped`);


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

    // PHASE 4: Upsert stock (deduplicate by variant_id, keep last)
    const stockMap = new Map<string, { variant_id: string; qty: number }>();
    for (const v of chunkVariations) {
      const productId = skuToProductId.get(v.parentSku);
      if (!productId) continue;
      const compositeKey = `${productId}:${v.shortMaatId}`;
      const variantId = skuToVariantId.get(compositeKey);
      if (!variantId) continue;
      stockMap.set(variantId, { variant_id: variantId, qty: v.stock });
    }
    const stockRecords = Array.from(stockMap.values());

    for (let i = 0; i < stockRecords.length; i += BATCH) {
      const batch = stockRecords.slice(i, i + BATCH);
      const { error } = await supabase
        .from('stock_totals').upsert(batch, { onConflict: 'variant_id' });
      if (error) console.error('Upsert stock:', error.message);
      else stats.stockUpserted += batch.length;
    }

    // === PHASE 5: Auto-enrich images from storage ===
    // Scan storage bucket for all w-N_{skubase} pattern files and link them
    console.log('[import-modis-csv] Phase 5: Auto-enriching images from storage...');
    const storageBase = `${supabaseUrl}/storage/v1/object/public/product-images/`;

    // Build storage file index (lowercase filename -> actual path)
    const bucketFileMap = new Map<string, string>();
    async function listBucketDir(dir: string) {
      let dirOffset = 0;
      while (true) {
        const { data: files } = await supabase.storage
          .from('product-images')
          .list(dir, { limit: 1000, offset: dirOffset });
        if (!files || files.length === 0) break;
        for (const f of files) {
          if (!f.name || !f.name.includes('.')) continue;
          const fullPath = dir ? `${dir}/${f.name}` : f.name;
          const justFilename = f.name.toLowerCase();
          if (!dir) {
            bucketFileMap.set(justFilename, fullPath);
          } else if (!bucketFileMap.has(justFilename)) {
            bucketFileMap.set(justFilename, fullPath);
          }
        }
        if (files.length < 1000) break;
        dirOffset += 1000;
      }
    }
    await Promise.all([listBucketDir(''), listBucketDir('modis/foto')]);
    console.log(`[import-modis-csv] Storage index: ${bucketFileMap.size} files`);

    // Build reverse index: sku-base (lowercase) -> sorted list of storage paths
    const skuBaseToFiles = new Map<string, string[]>();
    for (const [lowerName, storagePath] of bucketFileMap) {
      const match = lowerName.match(/^w-(\d+)_(.+)\.\w+$/);
      if (!match) continue;
      const skuBase = match[2];
      if (!skuBaseToFiles.has(skuBase)) skuBaseToFiles.set(skuBase, []);
      skuBaseToFiles.get(skuBase)!.push(storagePath);
    }
    for (const [, files] of skuBaseToFiles) {
      files.sort((a, b) => {
        const na = parseInt(a.toLowerCase().match(/w-(\d+)/)?.[1] || '0');
        const nb = parseInt(b.toLowerCase().match(/w-(\d+)/)?.[1] || '0');
        return na - nb;
      });
    }

    let imagesEnriched = 0;
    // Enrich products in this chunk
    for (const p of chunkParents) {
      const productId = skuToProductId.get(p.sku);
      if (!productId) continue;
      const skuBase = p.sku.replace(/0{3}$/, '').toLowerCase();
      const storageFiles = skuBaseToFiles.get(skuBase);
      if (!storageFiles || storageFiles.length <= 1) continue; // Only enrich if >1 image available

      // Current images from CSV (already stored)
      const currentCount = p.images.length;
      if (storageFiles.length <= currentCount) continue; // Already has enough

      const allStorageUrls = storageFiles.map(f => `${storageBase}${f}`);
      const { error: enrichErr } = await supabase
        .from('products')
        .update({ images: allStorageUrls })
        .eq('id', productId);
      if (!enrichErr) {
        imagesEnriched++;
        if (imagesEnriched <= 5) {
          console.log(`[import-modis-csv] Enriched ${p.sku}: ${currentCount} → ${allStorageUrls.length} images`);
        }
      }
    }
    console.log(`[import-modis-csv] Phase 5 complete: ${imagesEnriched} products enriched with additional images`);

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
