import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const tenantId = body.tenantId;
    const offset = body.offset || 0;
    const BATCH_SIZE = 100;

    if (!tenantId) {
      throw new Error('tenantId is required');
    }

    console.log(`Bulk create variants - tenant: ${tenantId}, offset: ${offset}`);

    // Fetch products without variants that have a Maat attribute
    const { data: products, error: fetchError } = await supabase
      .from('products')
      .select('id, sku, attributes, variants(id)')
      .eq('tenant_id', tenantId)
      .not('attributes', 'is', null)
      .range(offset, offset + BATCH_SIZE - 1);

    if (fetchError) throw fetchError;
    if (!products || products.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        complete: true,
        message: 'Geen producten meer te verwerken',
        offset,
        variantsCreated: 0,
        productsProcessed: 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Filter: only products WITHOUT variants and WITH Maat attribute
    const eligible = products.filter((p: any) => {
      const hasVariants = p.variants && p.variants.length > 0;
      const attrs = p.attributes as Record<string, any> | null;
      const hasMaat = attrs?.Maat && typeof attrs.Maat === 'string' && attrs.Maat.trim() !== '';
      return !hasVariants && hasMaat;
    });

    console.log(`Batch ${offset}: ${products.length} products fetched, ${eligible.length} eligible`);

    let totalVariantsCreated = 0;
    let productsProcessed = 0;

    for (const product of eligible) {
      const attrs = product.attributes as Record<string, any>;
      const maatStr = attrs.Maat as string;
      const sizes = maatStr.split(',').map((s: string) => s.trim()).filter(Boolean);

      if (sizes.length === 0) continue;

      const variantRecords = sizes.map((sizeEntry: string) => {
        const euSize = sizeEntry.split('=')[0].trim();
        return {
          product_id: product.id,
          size_label: euSize,
          maat_web: sizeEntry,
          maat_id: `${product.sku}-${euSize.replace(/[^0-9.]/g, '')}`,
          active: true,
        };
      });

      const { data: inserted, error: insertError } = await supabase
        .from('variants')
        .insert(variantRecords)
        .select('id');

      if (insertError) {
        console.error(`Error creating variants for ${product.sku}:`, insertError.message);
        continue;
      }

      // Create stock_totals entries
      if (inserted && inserted.length > 0) {
        const stockEntries = inserted.map((v: any) => ({
          variant_id: v.id,
          qty: 0,
        }));
        const { error: stockErr } = await supabase.from('stock_totals').insert(stockEntries);
        if (stockErr) {
          console.error(`Error creating stock for ${product.sku}:`, stockErr.message);
        }
      }

      totalVariantsCreated += inserted?.length || 0;
      productsProcessed++;
    }

    const hasMore = products.length === BATCH_SIZE;
    const nextOffset = offset + BATCH_SIZE;

    console.log(`Batch done: ${productsProcessed} products, ${totalVariantsCreated} variants created, hasMore: ${hasMore}`);

    return new Response(JSON.stringify({
      success: true,
      complete: !hasMore,
      hasMore,
      nextOffset,
      offset,
      productsProcessed,
      variantsCreated: totalVariantsCreated,
      batchSize: products.length,
      eligible: eligible.length,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

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
