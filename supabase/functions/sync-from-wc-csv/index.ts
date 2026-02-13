import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function parseCSVLine(line: string): string[] {
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
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function cleanHtml(text: string): string {
  // Remove vc_row/vc_column shortcodes and HTML tags
  return text
    .replace(/\[vc_[^\]]*\]/g, '')
    .replace(/\[\/vc_[^\]]*\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

interface CsvProduct {
  sku: string;
  title: string;
  shortDescription: string;
  description: string;
  categories: string;
  brand: string;
  images: string;
  attributes: Record<string, string>;
  metaTitle: string;
  metaDescription: string;
  metaKeywords: string;
  regularPrice: string;
  salePrice: string;
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
    const dryRun = body.dryRun !== false; // default true
    const storagePath = body.storagePath || 'import/wc-export-sync.csv';
    const offset = body.offset || 0;
    const batchSize = body.batchSize || 100;
    // Which fields to sync (all by default)
    const syncFields = body.syncFields || ['title', 'description', 'shortDescription', 'categories', 'brand', 'attributes', 'images', 'metaTitle', 'metaDescription', 'metaKeywords'];
    // overwrite: if true, overwrite existing DB values; if false, only fill empty fields
    const overwrite = body.overwrite === true;

    console.log(`Sync from WC CSV ${dryRun ? '(DRY RUN)' : '(LIVE)'}, offset=${offset}, overwrite=${overwrite}`);

    // Download CSV from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('order-exports')
      .download(storagePath);
    if (downloadError || !fileData) throw new Error(`Download failed: ${downloadError?.message}`);

    const csvText = (await fileData.text()).replace(/^\uFEFF/, '');
    const lines = csvText.split('\n');
    const headers = parseCSVLine(lines[0]);

    const col = (name: string) => headers.findIndex(h => h.trim() === name);

    const typeIdx = col('Type');
    const skuIdx = col('SKU');
    const nameIdx = col('Naam');
    const shortDescIdx = col('Korte beschrijving');
    const descIdx = col('Productbeschrijving');
    const categoriesIdx = col('Categorieën');
    const brandIdx = col('Merken');
    const imagesIdx = col('Afbeeldingen');
    const regularPriceIdx = col('Reguliere prijs');
    const salePriceIdx = col('Actieprijs');
    const metaTitleIdx = col('Meta: rank_math_title');
    const metaDescIdx = col('Meta: rank_math_description');
    const metaKeywordsIdx = col('Meta: rank_math_focus_keyword');

    // Find all attribute columns (Attribuut N naam / Attribuut N waarde(n))
    const attrColumns: { nameIdx: number; valueIdx: number }[] = [];
    for (let i = 1; i <= 20; i++) {
      const nIdx = col(`Attribuut ${i} naam`);
      const vIdx = col(`Attribuut ${i} waarde(n)`);
      if (nIdx >= 0 && vIdx >= 0) {
        attrColumns.push({ nameIdx: nIdx, valueIdx: vIdx });
      }
    }

    // Parse CSV parents (variable + simple only)
    const csvMap = new Map<string, CsvProduct>();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const f = parseCSVLine(line);
      const type = f[typeIdx]?.trim();
      const sku = f[skuIdx]?.trim();
      if ((type === 'variable' || type === 'simple') && sku) {
        // Parse attributes
        const attributes: Record<string, string> = {};
        for (const ac of attrColumns) {
          const attrName = f[ac.nameIdx]?.trim();
          const attrValue = f[ac.valueIdx]?.trim();
          if (attrName && attrValue && attrName !== 'Maat' && attrName !== 'Merk') {
            attributes[attrName] = attrValue;
          }
        }

        csvMap.set(sku, {
          sku,
          title: f[nameIdx]?.trim() || '',
          shortDescription: f[shortDescIdx]?.trim() || '',
          description: f[descIdx]?.trim() || '',
          categories: f[categoriesIdx]?.trim() || '',
          brand: brandIdx >= 0 ? (f[brandIdx]?.trim() || '') : '',
          images: f[imagesIdx]?.trim() || '',
          attributes,
          metaTitle: metaTitleIdx >= 0 ? (f[metaTitleIdx]?.trim() || '') : '',
          metaDescription: metaDescIdx >= 0 ? (f[metaDescIdx]?.trim() || '') : '',
          metaKeywords: metaKeywordsIdx >= 0 ? (f[metaKeywordsIdx]?.trim() || '') : '',
          regularPrice: regularPriceIdx >= 0 ? (f[regularPriceIdx]?.trim() || '') : '',
          salePrice: salePriceIdx >= 0 ? (f[salePriceIdx]?.trim() || '') : '',
        });
      }
    }

    console.log(`Parsed ${csvMap.size} CSV parent products`);

    // Pre-fetch all existing brands
    const { data: existingBrands } = await supabase.from('brands').select('id, name');
    const brandMap = new Map<string, string>();
    existingBrands?.forEach((b: any) => brandMap.set(b.name.toLowerCase(), b.id));

    // Fetch DB products in batch
    const { data: products, error: fetchErr } = await supabase
      .from('products')
      .select('id, sku, title, webshop_text, meta_description, meta_title, meta_keywords, images, categories, brand_id, attributes, url_key, brands(name)')
      .range(offset, offset + batchSize - 1);

    if (fetchErr) throw new Error(`Fetch products failed: ${fetchErr.message}`);
    if (!products || products.length === 0) {
      return new Response(JSON.stringify({
        success: true, done: true, message: 'No more products to process',
        offset, processed: 0
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const updates: any[] = [];
    const priceUpdates: any[] = [];
    const newBrandNames = new Set<string>();

    for (const p of products) {
      const csv = csvMap.get(p.sku);
      if (!csv) continue;

      const productUpdate: any = { sku: p.sku, id: p.id, changes: {} };
      let hasChanges = false;

      // Title
      if (syncFields.includes('title') && csv.title) {
        if (overwrite || !p.title || p.title === p.sku) {
          if (p.title !== csv.title) {
            productUpdate.changes.title = csv.title;
            hasChanges = true;
          }
        }
      }

      // Description (webshop_text)
      if (syncFields.includes('description') && csv.description) {
        const cleanDesc = cleanHtml(csv.description);
        if (overwrite || !p.webshop_text) {
          if (cleanDesc.length > 10 && p.webshop_text !== cleanDesc) {
            productUpdate.changes.webshop_text = cleanDesc;
            hasChanges = true;
          }
        }
      }

      // Short description -> meta_description
      if (syncFields.includes('shortDescription') && csv.shortDescription) {
        const cleanShort = cleanHtml(csv.shortDescription);
        if (overwrite || !p.meta_description) {
          if (cleanShort.length > 5 && p.meta_description !== cleanShort) {
            productUpdate.changes.meta_description = cleanShort;
            hasChanges = true;
          }
        }
      }

      // Categories
      if (syncFields.includes('categories') && csv.categories) {
        const dbCats = Array.isArray(p.categories) ? p.categories : [];
        if (overwrite || dbCats.length === 0) {
          const parsed = csv.categories
            .split(',')
            .map((c: string) => c.trim())
            .filter((c: string) => c && c !== 'Standaard categorie');
          if (parsed.length > 0) {
            productUpdate.changes.categories = parsed;
            hasChanges = true;
          }
        }
      }

      // Brand
      if (syncFields.includes('brand') && csv.brand) {
        const dbBrand = (p as any).brands?.name || '';
        if (overwrite || !dbBrand) {
          const cleanBrand = csv.brand.replace(/ (Heren|Dames)$/i, '').trim();
          if (cleanBrand) {
            const brandId = brandMap.get(cleanBrand.toLowerCase());
            if (brandId) {
              if (p.brand_id !== brandId) {
                productUpdate.changes.brand_id = brandId;
                hasChanges = true;
              }
            } else {
              newBrandNames.add(cleanBrand);
              productUpdate.pendingBrand = cleanBrand;
              hasChanges = true;
            }
          }
        }
      }

      // Attributes (merge with existing)
      if (syncFields.includes('attributes') && Object.keys(csv.attributes).length > 0) {
        const dbAttrs = (p.attributes && typeof p.attributes === 'object') ? p.attributes as Record<string, any> : {};
        const merged = { ...dbAttrs };
        let attrChanged = false;
        for (const [key, val] of Object.entries(csv.attributes)) {
          if (overwrite || !merged[key]) {
            if (merged[key] !== val) {
              merged[key] = val;
              attrChanged = true;
            }
          }
        }
        if (attrChanged) {
          productUpdate.changes.attributes = merged;
          hasChanges = true;
        }
      }

      // Images
      if (syncFields.includes('images') && csv.images) {
        const dbImages = Array.isArray(p.images) ? p.images : [];
        if (overwrite || dbImages.length === 0) {
          const csvImgs = csv.images.split(',').map((i: string) => i.trim()).filter(Boolean);
          if (csvImgs.length > 0) {
            productUpdate.changes.images = csvImgs;
            hasChanges = true;
          }
        }
      }

      // Meta title
      if (syncFields.includes('metaTitle') && csv.metaTitle) {
        if (overwrite || !p.meta_title) {
          if (p.meta_title !== csv.metaTitle) {
            productUpdate.changes.meta_title = csv.metaTitle;
            hasChanges = true;
          }
        }
      }

      // Meta description (from rank_math)
      if (syncFields.includes('metaDescription') && csv.metaDescription) {
        // Only use rank_math description if we haven't already set meta_description from short description
        if (!productUpdate.changes.meta_description) {
          if (overwrite || !p.meta_description) {
            if (p.meta_description !== csv.metaDescription) {
              productUpdate.changes.meta_description = csv.metaDescription;
              hasChanges = true;
            }
          }
        }
      }

      // Meta keywords
      if (syncFields.includes('metaKeywords') && csv.metaKeywords) {
        if (overwrite || !p.meta_keywords) {
          if (p.meta_keywords !== csv.metaKeywords) {
            productUpdate.changes.meta_keywords = csv.metaKeywords;
            hasChanges = true;
          }
        }
      }

      if (hasChanges) {
        updates.push(productUpdate);
      }
    }

    console.log(`Found ${updates.length} products to update out of ${products.length} checked`);

    if (dryRun) {
      return new Response(JSON.stringify({
        success: true,
        mode: 'dry_run',
        offset,
        products_checked: products.length,
        products_to_update: updates.length,
        new_brands_needed: [...newBrandNames],
        hasMore: products.length >= batchSize,
        nextOffset: offset + batchSize,
        sample_updates: updates.slice(0, 5).map(u => ({
          sku: u.sku,
          fields_changed: Object.keys(u.changes),
          pendingBrand: u.pendingBrand,
        })),
        all_updates: updates.map(u => ({
          sku: u.sku,
          fields_changed: Object.keys(u.changes),
        })),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // LIVE MODE

    // Create missing brands first
    if (newBrandNames.size > 0) {
      const { data: created } = await supabase
        .from('brands')
        .insert([...newBrandNames].map(name => ({ name })))
        .select('id, name');
      created?.forEach((b: any) => brandMap.set(b.name.toLowerCase(), b.id));
      console.log(`Created ${created?.length || 0} new brands`);
    }

    // Apply updates in parallel batches
    let updated = 0;
    let errors = 0;
    const BATCH = 20;

    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const promises = batch.map(upd => {
        const changes = { ...upd.changes };
        // Resolve pending brand
        if (upd.pendingBrand) {
          const brandId = brandMap.get(upd.pendingBrand.toLowerCase());
          if (brandId) changes.brand_id = brandId;
        }
        return supabase.from('products').update(changes).eq('id', upd.id);
      });
      const results = await Promise.all(promises);
      results.forEach((r, idx) => {
        if (r.error) {
          console.error(`Update failed ${batch[idx].sku}:`, r.error.message);
          errors++;
        } else {
          updated++;
        }
      });
    }

    console.log(`Updated ${updated} products, ${errors} errors`);

    return new Response(JSON.stringify({
      success: true,
      mode: 'live',
      offset,
      products_checked: products.length,
      products_updated: updated,
      errors,
      new_brands_created: newBrandNames.size,
      hasMore: products.length >= batchSize,
      nextOffset: offset + batchSize,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
