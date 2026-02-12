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

    // Find products with modis/foto paths using text cast filter
    // PostgREST doesn't support LIKE on jsonb, so we fetch in batches and filter
    const allProducts: any[] = [];
    let from = 0;
    const batchSize = 1000;
    while (true) {
      const { data: batch, error: batchError } = await supabase
        .from('products')
        .select('id, sku, images')
        .not('images', 'is', null)
        .range(from, from + batchSize - 1);
      
      if (batchError) throw batchError;
      if (!batch || batch.length === 0) break;
      
      for (const p of batch) {
        const imagesStr = JSON.stringify(p.images || []);
        if (imagesStr.includes('modis/foto')) {
          allProducts.push(p);
        }
      }
      
      if (batch.length < batchSize) break;
      from += batchSize;
    }
    
    const products = allProducts;
    console.log(`Found ${products.length} products with modis/foto paths`);

    console.log(`Found ${products?.length || 0} products with modis/foto paths`);

    let fixedCount = 0;
    const missingImages: string[] = [];

    for (const product of products || []) {
      const images = product.images as string[];
      if (!images || images.length === 0) continue;

      // Split semicolon-separated paths and convert to Storage URLs
      const newImages: string[] = [];
      for (const img of images) {
        // Split by semicolon in case multiple paths are in one string
        const paths = img.includes(';') ? img.split(';') : [img];
        for (const path of paths) {
          const trimmed = path.trim();
          if (!trimmed) continue;
          // Extract just the filename from "modis/foto/W-1_270079005.JPG"
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

    // Deduplicate missing images list
    const uniqueImages = [...new Set(missingImages)];

    // Check which images already exist in storage
    const existingSet = new Set<string>();
    // List in batches (storage list returns max 100 by default)
    let offset = 0;
    const limit = 1000;
    while (true) {
      const { data: files } = await supabase.storage
        .from('product-images')
        .list('', { limit, offset });

      if (!files || files.length === 0) break;
      files.forEach(f => existingSet.add(f.name));
      if (files.length < limit) break;
      offset += limit;
    }

    const actuallyMissing = uniqueImages.filter(img => !existingSet.has(img));

    console.log(`Fixed ${fixedCount} products. ${actuallyMissing.length} images need to be uploaded from SFTP.`);

    return new Response(
      JSON.stringify({
        success: true,
        fixedProducts: fixedCount,
        totalUniqueImages: uniqueImages.length,
        alreadyInStorage: uniqueImages.length - actuallyMissing.length,
        missingFromStorage: actuallyMissing.length,
        missingImages: actuallyMissing.slice(0, 50), // Sample
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
