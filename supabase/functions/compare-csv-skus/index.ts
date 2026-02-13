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
    const storagePath = body.storagePath || 'import/wc-export-old-shop.csv';

    console.log('Downloading CSV from storage...');
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('order-exports')
      .download(storagePath);

    if (downloadError || !fileData) {
      throw new Error(`Failed to download CSV: ${downloadError?.message}`);
    }

    const csvText = await fileData.text();
    // Remove BOM
    const cleanText = csvText.replace(/^\uFEFF/, '');
    const lines = cleanText.split('\n');

    console.log(`CSV has ${lines.length} lines`);

    const headers = parseCSVLine(lines[0]);
    const typeIdx = headers.findIndex(h => h.trim() === 'Type');
    const skuIdx = headers.findIndex(h => h.trim() === 'SKU');
    const nameIdx = headers.findIndex(h => h.trim() === 'Naam');
    const publishedIdx = headers.findIndex(h => h.trim() === 'Gepubliceerd');
    const priceIdx = headers.findIndex(h => h.trim() === 'Reguliere prijs');
    const salePriceIdx = headers.findIndex(h => h.trim() === 'Actieprijs');
    const categoriesIdx = headers.findIndex(h => h.trim() === 'Categorieën');
    const imagesIdx = headers.findIndex(h => h.trim() === 'Afbeeldingen');
    const brandIdx = headers.findIndex(h => h.trim().toLowerCase() === 'meta: merknaam');
    const descIdx = headers.findIndex(h => h.trim() === 'Beschrijving');

    console.log(`Column indices: type=${typeIdx}, sku=${skuIdx}, name=${nameIdx}`);

    // Extract parent product SKUs (variable and simple types only)
    const csvParents: { sku: string; name: string; type: string; published: string; price: string; categories: string; hasImages: boolean; brand: string }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = parseCSVLine(line);
      const type = fields[typeIdx]?.trim();
      const sku = fields[skuIdx]?.trim();

      if ((type === 'variable' || type === 'simple') && sku) {
        csvParents.push({
          sku,
          name: fields[nameIdx]?.trim() || '',
          type,
          published: fields[publishedIdx]?.trim() || '0',
          price: fields[priceIdx]?.trim() || '',
          categories: fields[categoriesIdx]?.trim() || '',
          hasImages: !!(fields[imagesIdx]?.trim()),
          brand: brandIdx >= 0 ? (fields[brandIdx]?.trim() || '') : '',
        });
      }
    }

    console.log(`Found ${csvParents.length} parent products in CSV`);

    // Get all DB SKUs
    const dbSkus = new Set<string>();
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('sku')
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      data.forEach((p: any) => dbSkus.add(p.sku));
      if (data.length < 1000) break;
      offset += 1000;
    }

    console.log(`Found ${dbSkus.size} products in database`);

    // Find missing
    const missingInDb = csvParents.filter(p => !dbSkus.has(p.sku));
    const existingInDb = csvParents.filter(p => dbSkus.has(p.sku));

    // Also find DB products not in CSV
    const csvSkuSet = new Set(csvParents.map(p => p.sku));
    // Query DB products not in CSV (sample)
    const onlyInDb: string[] = [];
    for (const sku of dbSkus) {
      if (!csvSkuSet.has(sku)) onlyInDb.push(sku);
    }

    console.log(`Missing in DB: ${missingInDb.length}`);
    console.log(`Only in DB (not in CSV): ${onlyInDb.length}`);

    return new Response(JSON.stringify({
      success: true,
      csv_parent_products: csvParents.length,
      db_products: dbSkus.size,
      missing_in_db: missingInDb.length,
      existing_in_both: existingInDb.length,
      only_in_db: onlyInDb.length,
      missing_products: missingInDb,
      only_in_db_skus: onlyInDb.slice(0, 50),
    }), {
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
