import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Download CSV from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('order-exports')
      .download('import/products-totaal.csv');

    if (downloadError || !fileData) {
      throw new Error(`Failed to download CSV: ${downloadError?.message}`);
    }

    const csvText = await fileData.text();
    const rows = parseSemicolonCSV(csvText);
    const headers = rows[0];

    const typeIdx = headers.findIndex(h => h === 'Type');
    const skuIdx = headers.findIndex(h => h === 'SKU');
    const nameIdx = headers.findIndex(h => h.toLowerCase() === 'name');
    const parentIdx = headers.findIndex(h => h === 'Parent');

    // Build map: variation SKU -> size from product name
    const skuToSize = new Map<string, string>();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[typeIdx]?.trim() !== 'variation') continue;
      const sku = row[skuIdx]?.trim();
      const name = row[nameIdx]?.trim();
      if (!sku || !name) continue;

      const match = name.match(/ - ([^-]+)$/);
      if (match) {
        skuToSize.set(sku, match[1].trim());
      }
    }

    console.log(`CSV variation name map: ${skuToSize.size} entries`);

    // Get variants with SKU-style size_labels
    const { data: badVariants } = await supabase
      .from('variants')
      .select('id, maat_id, size_label')
      .like('size_label', '%-%')
      .gt('size_label', '10 characters'); // This won't work, use filter below

    // Actually fetch all and filter in code
    const allBad: any[] = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('variants')
        .select('id, maat_id, size_label')
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      for (const v of data) {
        if (v.size_label && v.size_label.includes('-') && v.size_label.length > 10) {
          allBad.push(v);
        }
      }
      if (data.length < 1000) break;
      offset += 1000;
    }

    console.log(`Found ${allBad.length} variants with SKU-style size_labels`);

    let updated = 0;
    let notFound = 0;

    for (const variant of allBad) {
      // The maat_id IS the full variation SKU for these
      const newSize = skuToSize.get(variant.maat_id) || skuToSize.get(variant.size_label);
      
      if (newSize) {
        const { error } = await supabase
          .from('variants')
          .update({ size_label: newSize })
          .eq('id', variant.id);
        
        if (!error) {
          updated++;
        } else {
          console.error(`Failed to update ${variant.id}:`, error.message);
        }
      } else {
        notFound++;
        console.log(`No CSV match for maat_id=${variant.maat_id}, size_label=${variant.size_label}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      totalBad: allBad.length,
      updated,
      notFound,
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
