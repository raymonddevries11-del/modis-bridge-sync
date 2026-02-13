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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun !== false; // default true = preview only
    const storagePath = body.storagePath || 'import/wc-export-old-shop.csv';

    console.log(`Enrichment ${dryRun ? '(DRY RUN)' : '(LIVE)'} starting...`);

    // Download CSV
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
    const categoriesIdx = col('Categorieën');
    const brandIdx = headers.findIndex(h => h.trim() === 'Meta: merknaam');

    // Parse CSV parents
    const csvMap = new Map<string, { categories: string; brand: string }>();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const f = parseCSVLine(line);
      const type = f[typeIdx]?.trim();
      const sku = f[skuIdx]?.trim();
      if ((type === 'variable' || type === 'simple') && sku) {
        csvMap.set(sku, {
          categories: f[categoriesIdx]?.trim() || '',
          brand: brandIdx >= 0 ? (f[brandIdx]?.trim() || '') : '',
        });
      }
    }

    console.log(`Parsed ${csvMap.size} CSV parents`);

    // Pre-fetch all existing brands
    const { data: existingBrands } = await supabase.from('brands').select('id, name');
    const brandMap = new Map<string, string>();
    existingBrands?.forEach((b: any) => brandMap.set(b.name.toLowerCase(), b.id));

    // Collect unique new brand names from CSV that need creating
    const newBrandNames = new Set<string>();

    // First pass: identify products to update and new brands needed
    const categoryUpdates: { sku: string; categories: string[] }[] = [];
    const brandUpdates: { sku: string; brandName: string }[] = [];

    let offset = 0;
    while (true) {
      const { data: products } = await supabase
        .from('products')
        .select('id, sku, categories, brand_id')
        .range(offset, offset + 999);
      if (!products || products.length === 0) break;

      for (const p of products) {
        const csv = csvMap.get(p.sku);
        if (!csv) continue;

        // Categories: only if DB has none and CSV has some
        const dbCats = Array.isArray(p.categories) ? p.categories : [];
        if (dbCats.length === 0 && csv.categories) {
          // Parse WooCommerce category format: "Cat1 > Sub1, Cat2 > Sub2"
          const parsed = csv.categories
            .split(',')
            .map((c: string) => c.trim())
            .filter((c: string) => c && c !== '0000 -' && c !== 'Standaard categorie');
          if (parsed.length > 0) {
            categoryUpdates.push({ sku: p.sku, categories: parsed });
          }
        }

        // Brand: only if DB has none and CSV has one
        if (!p.brand_id && csv.brand) {
          // Normalize brand name (remove " Heren"/" Dames" suffixes for matching)
          const cleanBrand = csv.brand.replace(/ (Heren|Dames)$/i, '').trim();
          brandUpdates.push({ sku: p.sku, brandName: cleanBrand });
          if (!brandMap.has(cleanBrand.toLowerCase())) {
            newBrandNames.add(cleanBrand);
          }
        }
      }

      if (products.length < 1000) break;
      offset += 1000;
    }

    console.log(`Category updates: ${categoryUpdates.length}, Brand updates: ${brandUpdates.length}, New brands: ${newBrandNames.size}`);

    if (dryRun) {
      return new Response(JSON.stringify({
        success: true,
        mode: 'dry_run',
        category_updates: categoryUpdates.length,
        brand_updates: brandUpdates.length,
        new_brands_to_create: [...newBrandNames],
        sample_category_updates: categoryUpdates.slice(0, 5),
        sample_brand_updates: brandUpdates.slice(0, 5),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // LIVE MODE: Create missing brands first
    if (newBrandNames.size > 0) {
      const { data: created } = await supabase
        .from('brands')
        .insert([...newBrandNames].map(name => ({ name })))
        .select('id, name');
      created?.forEach((b: any) => brandMap.set(b.name.toLowerCase(), b.id));
      console.log(`Created ${created?.length || 0} new brands`);
    }

    // Apply category updates - batch by grouping same categories
    let catUpdated = 0;
    const BATCH = 20;
    for (let i = 0; i < categoryUpdates.length; i += BATCH) {
      const batch = categoryUpdates.slice(i, i + BATCH);
      const promises = batch.map(upd =>
        supabase.from('products').update({ categories: upd.categories }).eq('sku', upd.sku)
      );
      const results = await Promise.all(promises);
      catUpdated += results.filter(r => !r.error).length;
      results.forEach((r, idx) => {
        if (r.error) console.error(`Cat failed ${batch[idx].sku}:`, r.error.message);
      });
    }

    // Apply brand updates in parallel batches
    let brandUpdated = 0;
    for (let i = 0; i < brandUpdates.length; i += BATCH) {
      const batch = brandUpdates.slice(i, i + BATCH);
      const promises = batch.map(upd => {
        const brandId = brandMap.get(upd.brandName.toLowerCase());
        if (!brandId) return Promise.resolve({ error: { message: 'not found' } });
        return supabase.from('products').update({ brand_id: brandId }).eq('sku', upd.sku);
      });
      const results = await Promise.all(promises);
      brandUpdated += results.filter(r => !r.error).length;
    }

    console.log(`Done: ${catUpdated} categories, ${brandUpdated} brands updated`);

    return new Response(JSON.stringify({
      success: true,
      mode: 'live',
      categories_updated: catUpdated,
      brands_updated: brandUpdated,
      new_brands_created: newBrandNames.size,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
