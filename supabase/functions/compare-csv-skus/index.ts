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
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
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
    const storagePath = body.storagePath || 'import/wc-export-old-shop.csv';

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
    const nameIdx = col('Naam');
    const descIdx = col('Beschrijving');
    const shortDescIdx = col('Korte beschrijving');
    const priceIdx = col('Reguliere prijs');
    const salePriceIdx = col('Actieprijs');
    const categoriesIdx = col('Categorieën');
    const imagesIdx = col('Afbeeldingen');
    // Brand is in meta field
    const brandIdx = headers.findIndex(h => h.trim() === 'Meta: merknaam');

    // Parse CSV parents
    const csvMap = new Map<string, any>();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const f = parseCSVLine(line);
      const type = f[typeIdx]?.trim();
      const sku = f[skuIdx]?.trim();
      if ((type === 'variable' || type === 'simple') && sku) {
        csvMap.set(sku, {
          name: f[nameIdx]?.trim() || '',
          description: f[descIdx]?.trim() || '',
          shortDescription: f[shortDescIdx]?.trim() || '',
          price: f[priceIdx]?.trim() || '',
          salePrice: f[salePriceIdx]?.trim() || '',
          categories: f[categoriesIdx]?.trim() || '',
          images: f[imagesIdx]?.trim() || '',
          brand: brandIdx >= 0 ? (f[brandIdx]?.trim() || '') : '',
        });
      }
    }

    console.log(`Parsed ${csvMap.size} CSV parents`);

    // Get DB products with related data
    const enrichments = {
      description_available: [] as any[],  // CSV has desc, DB doesn't
      images_available: [] as any[],       // CSV has images, DB doesn't
      categories_available: [] as any[],   // CSV has categories, DB doesn't
      brand_available: [] as any[],        // CSV has brand, DB doesn't
      price_available: [] as any[],        // CSV has price, DB doesn't
    };

    // Fetch DB products in batches
    let offset = 0;
    let totalChecked = 0;
    while (true) {
      const { data: products } = await supabase
        .from('products')
        .select('sku, title, webshop_text, images, categories, brand_id, brands(name), product_prices(regular, list)')
        .range(offset, offset + 499);

      if (!products || products.length === 0) break;

      for (const p of products) {
        const csv = csvMap.get(p.sku);
        if (!csv) continue;
        totalChecked++;

        const dbDesc = p.webshop_text?.trim() || '';
        const csvDesc = cleanHtml(csv.description || csv.shortDescription || '');
        const dbImages = Array.isArray(p.images) ? p.images : [];
        const csvImages = csv.images ? csv.images.split(',').map((i: string) => i.trim()).filter(Boolean) : [];
        const dbCats = Array.isArray(p.categories) ? p.categories : [];
        const csvCats = csv.categories ? csv.categories.split(',').map((c: string) => c.trim()).filter(Boolean) : [];
        const dbBrand = (p as any).brands?.name || '';
        const csvBrand = csv.brand || '';
        const dbPrice = (p as any).product_prices?.[0]?.regular || (p as any).product_prices?.regular || null;

        // Check: CSV has description, DB doesn't
        if (!dbDesc && csvDesc.length > 10) {
          enrichments.description_available.push({
            sku: p.sku,
            title: p.title,
            csv_description: csvDesc.substring(0, 200),
          });
        }

        // Check: CSV has images, DB doesn't
        if (dbImages.length === 0 && csvImages.length > 0) {
          enrichments.images_available.push({
            sku: p.sku,
            title: p.title,
            csv_image_count: csvImages.length,
            csv_images: csvImages.slice(0, 3),
          });
        }

        // Check: CSV has categories, DB doesn't
        if (dbCats.length === 0 && csvCats.length > 0) {
          enrichments.categories_available.push({
            sku: p.sku,
            title: p.title,
            csv_categories: csv.categories,
          });
        }

        // Check: CSV has brand, DB doesn't
        if (!dbBrand && csvBrand) {
          enrichments.brand_available.push({
            sku: p.sku,
            title: p.title,
            csv_brand: csvBrand,
          });
        }

        // Check: CSV has price, DB doesn't
        if (!dbPrice && csv.price) {
          enrichments.price_available.push({
            sku: p.sku,
            title: p.title,
            csv_price: csv.price,
            csv_sale_price: csv.salePrice,
          });
        }
      }

      if (products.length < 500) break;
      offset += 500;
    }

    const summary = {
      success: true,
      products_compared: totalChecked,
      enrichment_opportunities: {
        description: {
          count: enrichments.description_available.length,
          examples: enrichments.description_available.slice(0, 10),
        },
        images: {
          count: enrichments.images_available.length,
          examples: enrichments.images_available.slice(0, 10),
        },
        categories: {
          count: enrichments.categories_available.length,
          examples: enrichments.categories_available.slice(0, 10),
        },
        brand: {
          count: enrichments.brand_available.length,
          examples: enrichments.brand_available.slice(0, 10),
        },
        price: {
          count: enrichments.price_available.length,
          examples: enrichments.price_available.slice(0, 10),
        },
      },
    };

    console.log('Comparison summary:', JSON.stringify({
      compared: totalChecked,
      desc: enrichments.description_available.length,
      img: enrichments.images_available.length,
      cat: enrichments.categories_available.length,
      brand: enrichments.brand_available.length,
      price: enrichments.price_available.length,
    }));

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
