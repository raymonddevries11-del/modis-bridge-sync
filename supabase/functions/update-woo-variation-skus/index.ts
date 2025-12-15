import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface VariationUpdate {
  id: number;
  parentId: number;
  newSku: string;
}

// Parse CSV content
function parseCsv(csvContent: string): VariationUpdate[] {
  const lines = csvContent.split('\n');
  if (lines.length < 2) return [];
  
  // Parse header to find column indices
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const idIndex = header.findIndex(h => h === 'ID');
  const parentIdIndex = header.findIndex(h => h === 'Parent');
  const typeIndex = header.findIndex(h => h === 'Type');
  const newSkuIndex = header.findIndex(h => h === 'Mds-art-maatbalk-maat');
  
  console.log(`CSV Header indices - ID: ${idIndex}, Parent: ${parentIdIndex}, Type: ${typeIndex}, NewSku: ${newSkuIndex}`);
  
  if (idIndex === -1 || newSkuIndex === -1 || typeIndex === -1) {
    throw new Error(`Required columns not found. Found headers: ${header.join(', ')}`);
  }
  
  const updates: VariationUpdate[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Handle CSV with quoted fields
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    const type = values[typeIndex]?.replace(/"/g, '');
    const id = parseInt(values[idIndex]?.replace(/"/g, '') || '0');
    const parentId = parseInt(values[parentIdIndex]?.replace(/"/g, '') || '0');
    const newSku = values[newSkuIndex]?.replace(/"/g, '').trim();
    
    // Only process variations with valid data
    if (type === 'variation' && id > 0 && newSku) {
      updates.push({ id, parentId, newSku });
    }
  }
  
  return updates;
}

// Make WooCommerce API request
async function wooRequest(
  baseUrl: string,
  consumerKey: string,
  consumerSecret: string,
  endpoint: string,
  method: string = 'GET',
  body?: any
): Promise<any> {
  const url = `${baseUrl}/wp-json/wc/v3${endpoint}`;
  const auth = btoa(`${consumerKey}:${consumerSecret}`);
  
  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WooCommerce API error: ${response.status} - ${text.substring(0, 200)}`);
  }
  
  return response.json();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { csvContent, tenantId } = await req.json();
    
    if (!csvContent || !tenantId) {
      return new Response(
        JSON.stringify({ error: 'csvContent and tenantId required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Tenant config not found: ${configError?.message}`);
    }

    const { woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret } = tenantConfig;

    // Parse CSV
    const updates = parseCsv(csvContent);
    console.log(`Parsed ${updates.length} variation updates from CSV`);
    
    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ success: true, updated: 0, errors: 0, message: 'No variations found in CSV' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Group updates by parent product ID for batch processing
    const updatesByParent = new Map<number, VariationUpdate[]>();
    for (const update of updates) {
      const existing = updatesByParent.get(update.parentId) || [];
      existing.push(update);
      updatesByParent.set(update.parentId, existing);
    }
    
    console.log(`Grouped into ${updatesByParent.size} parent products`);

    let totalUpdated = 0;
    let totalErrors = 0;
    const errorDetails: string[] = [];
    
    // Process each parent product's variations
    const parentIds = Array.from(updatesByParent.keys());
    const BATCH_SIZE = 10; // Process 10 parent products at a time
    const DELAY_MS = 2000; // 2 second delay between batches
    
    for (let i = 0; i < parentIds.length; i += BATCH_SIZE) {
      const batchParentIds = parentIds.slice(i, i + BATCH_SIZE);
      
      console.log(`Processing parent batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(parentIds.length/BATCH_SIZE)}`);
      
      // Process each parent in this batch
      for (const parentId of batchParentIds) {
        const variationUpdates = updatesByParent.get(parentId) || [];
        
        try {
          // Use WooCommerce batch endpoint for variations
          const batchPayload = {
            update: variationUpdates.map(v => ({
              id: v.id,
              sku: v.newSku,
            })),
          };
          
          const result = await wooRequest(
            woocommerce_url,
            woocommerce_consumer_key,
            woocommerce_consumer_secret,
            `/products/${parentId}/variations/batch`,
            'POST',
            batchPayload
          );
          
          // Count successes and failures
          if (result.update) {
            for (const updated of result.update) {
              if (updated.id) {
                totalUpdated++;
                console.log(`Updated variation ${updated.id} SKU to ${updated.sku}`);
              }
            }
          }
        } catch (error: any) {
          console.error(`Error updating variations for parent ${parentId}:`, error.message);
          totalErrors += variationUpdates.length;
          errorDetails.push(`Parent ${parentId}: ${error.message}`);
        }
      }
      
      // Delay between batches to respect rate limits
      if (i + BATCH_SIZE < parentIds.length) {
        console.log(`Waiting ${DELAY_MS}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    // Log to changelog
    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_SKU_UPDATE',
      description: `WooCommerce variation SKUs updated: ${totalUpdated} successful, ${totalErrors} errors`,
      metadata: {
        total_variations: updates.length,
        updated: totalUpdated,
        errors: totalErrors,
        error_details: errorDetails.slice(0, 10), // First 10 errors
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        updated: totalUpdated,
        errors: totalErrors,
        total: updates.length,
        errorDetails: errorDetails.slice(0, 10),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in update-woo-variation-skus:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
