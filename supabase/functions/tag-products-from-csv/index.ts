import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const tag = formData.get('tag') as string;
    const tenantId = formData.get('tenantId') as string;

    if (!file || !tag || !tenantId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: file, tag, tenantId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing CSV for tag "${tag}" and tenant ${tenantId}`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse CSV
    const csvText = await file.text();
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      return new Response(
        JSON.stringify({ error: 'CSV must have a header row and at least one data row' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse header to find SKU column
    const header = parseCSVLine(lines[0]);
    const skuIndex = header.findIndex(h => 
      h.toLowerCase() === 'sku' || 
      h.toLowerCase() === 'artikelnummer' ||
      h.toLowerCase() === 'article_number'
    );

    if (skuIndex === -1) {
      return new Response(
        JSON.stringify({ error: 'CSV must have a SKU, Artikelnummer, or article_number column' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract SKUs from CSV
    const skus: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i]);
      const sku = row[skuIndex]?.trim();
      if (sku && !skus.includes(sku)) {
        skus.push(sku);
      }
    }

    console.log(`Found ${skus.length} unique SKUs in CSV`);

    // Process in batches of 100
    const batchSize = 100;
    let updated = 0;
    let notFound: string[] = [];

    for (let i = 0; i < skus.length; i += batchSize) {
      const batch = skus.slice(i, i + batchSize);
      
      // First, get existing products with their current tags
      const { data: existingProducts, error: fetchError } = await supabase
        .from('products')
        .select('id, sku, tags')
        .eq('tenant_id', tenantId)
        .in('sku', batch);

      if (fetchError) {
        console.error('Error fetching products:', fetchError);
        continue;
      }

      const foundSkus = new Set(existingProducts?.map(p => p.sku) || []);
      
      // Track not found SKUs
      batch.forEach(sku => {
        if (!foundSkus.has(sku)) {
          notFound.push(sku);
        }
      });

      // Update each product's tags (add tag if not already present)
      for (const product of existingProducts || []) {
        const currentTags = product.tags || [];
        if (!currentTags.includes(tag)) {
          const newTags = [...currentTags, tag];
          
          const { error: updateError } = await supabase
            .from('products')
            .update({ tags: newTags })
            .eq('id', product.id);

          if (updateError) {
            console.error(`Error updating product ${product.sku}:`, updateError);
          } else {
            updated++;
          }
        } else {
          // Already has the tag
          updated++;
        }
      }
    }

    console.log(`Updated ${updated} products, ${notFound.length} SKUs not found`);

    return new Response(
      JSON.stringify({
        success: true,
        tag,
        totalSkusInCsv: skus.length,
        updated,
        notFound: notFound.slice(0, 50), // Return first 50 not found for review
        notFoundCount: notFound.length
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error processing CSV:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Helper function to parse CSV line handling quoted fields
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((char === ',' || char === ';') && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}
