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
    const tenantSlug = body.tenant || 'kosterschoenmode';
    const offset = body.offset || 0;
    const chunkSize = body.chunkSize || 500;

    // Get tenant
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');

    // Find products with modis/foto paths in this chunk
    const { data: batch, error: batchError } = await supabase
      .from('products')
      .select('id, sku, images')
      .eq('tenant_id', tenant.id)
      .not('images', 'is', null)
      .range(offset, offset + chunkSize - 1);

    if (batchError) throw batchError;
    if (!batch || batch.length === 0) {
      return new Response(JSON.stringify({
        success: true, complete: true, fixedProducts: 0, message: 'No more products to process',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Filter only products that still have modis/foto paths
    const toFix = batch.filter(p => JSON.stringify(p.images || []).includes('modis/foto'));

    console.log(`Chunk ${offset}: ${batch.length} fetched, ${toFix.length} need fixing`);

    let fixedCount = 0;
    const missingImages: string[] = [];

    for (const product of toFix) {
      const images = product.images as string[];
      if (!images || images.length === 0) continue;

      const newImages: string[] = [];
      for (const img of images) {
        const paths = img.includes(';') ? img.split(';') : [img];
        for (const path of paths) {
          const trimmed = path.trim();
          if (!trimmed) continue;
          const filename = trimmed.split('/').pop() || trimmed;
          const storageUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${filename}`;
          newImages.push(storageUrl);
          missingImages.push(filename);
        }
      }

      if (newImages.length > 0) {
        const { error: updateError } = await supabase
          .from('products')
          .update({ images: newImages })
          .eq('id', product.id);

        if (updateError) {
          console.error(`Error updating ${product.sku}:`, updateError);
        } else {
          fixedCount++;
        }
      }
    }

    const uniqueImages = [...new Set(missingImages)];
    const nextOffset = offset + batch.length;
    const hasMore = batch.length === chunkSize;

    return new Response(
      JSON.stringify({
        success: true,
        complete: !hasMore,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        fixedProducts: fixedCount,
        totalInChunk: batch.length,
        totalUniqueImages: uniqueImages.length,
        missingImages: uniqueImages.slice(0, 20),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
