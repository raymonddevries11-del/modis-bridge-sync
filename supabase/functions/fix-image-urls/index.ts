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
    const chunkSize = body.chunkSize || 200;
    const dryRun = body.dryRun || false;

    // Get tenant
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');

    // Pre-fetch list of files in storage bucket (paginated, up to 10000)
    const bucketFiles = new Set<string>();
    let bucketOffset = 0;
    while (true) {
      const { data: files } = await supabase.storage
        .from('product-images')
        .list('', { limit: 1000, offset: bucketOffset });
      if (!files || files.length === 0) break;
      for (const f of files) {
        bucketFiles.add(f.name);
        // Also add lowercase version for case-insensitive matching
        bucketFiles.add(f.name.toLowerCase());
      }
      if (files.length < 1000) break;
      bucketOffset += 1000;
    }

    console.log(`Loaded ${bucketFiles.size / 2} files from storage bucket`);

    // Get products in this chunk
    const { data: batch, error: batchError } = await supabase
      .from('products')
      .select('id, sku, images')
      .eq('tenant_id', tenant.id)
      .not('images', 'is', null)
      .range(offset, offset + chunkSize - 1);

    if (batchError) throw batchError;
    if (!batch || batch.length === 0) {
      return new Response(JSON.stringify({
        success: true, complete: true, fixedProducts: 0,
        message: 'No more products to process',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const storageBase = `${supabaseUrl}/storage/v1/object/public/product-images/`;

    // Filter products that have external URLs (not pointing to our storage)
    const toFix = batch.filter(p => {
      const imgs = p.images as string[];
      if (!Array.isArray(imgs) || imgs.length === 0) return false;
      return imgs.some(url =>
        typeof url === 'string' && !url.includes('supabase.co/storage')
      );
    });

    console.log(`Chunk ${offset}: ${batch.length} fetched, ${toFix.length} have external URLs`);

    let fixedCount = 0;
    let convertedUrls = 0;
    let notFoundInBucket = 0;
    const notFoundSamples: string[] = [];

    for (const product of toFix) {
      const images = product.images as string[];
      if (!Array.isArray(images)) continue;

      let changed = false;
      const newImages: string[] = [];

      for (const img of images) {
        if (typeof img !== 'string' || !img) continue;

        // Already points to our storage — keep as-is
        if (img.includes('supabase.co/storage')) {
          newImages.push(img);
          continue;
        }

        // Extract filename from URL or path
        let filename = '';
        if (img.includes('modis/foto')) {
          // Old modis path: extract and split on semicolons
          const paths = img.includes(';') ? img.split(';') : [img];
          for (const path of paths) {
            const trimmed = path.trim();
            if (!trimmed) continue;
            filename = trimmed.split('/').pop() || trimmed;
            const found = bucketFiles.has(filename) || bucketFiles.has(filename.toLowerCase());
            if (found) {
              // Use the actual filename (preserve case from bucket)
              const actualName = bucketFiles.has(filename) ? filename : filename;
              newImages.push(`${storageBase}${actualName}`);
              convertedUrls++;
              changed = true;
            } else {
              // Keep original if not in bucket
              newImages.push(img);
              notFoundInBucket++;
              if (notFoundSamples.length < 10) notFoundSamples.push(filename);
            }
          }
          continue;
        }

        // External URL (kosterschoenmode.nl, etc): extract filename
        try {
          const url = new URL(img);
          filename = url.pathname.split('/').pop() || '';
        } catch {
          filename = img.split('/').pop() || img;
        }

        if (!filename) {
          newImages.push(img);
          continue;
        }

        // Check if file exists in bucket (try original and uppercase JPG variants)
        const variants = [
          filename,
          filename.replace('.jpg', '.JPG'),
          filename.replace('.JPG', '.jpg'),
          filename.replace('.jpeg', '.JPG'),
          filename.replace('.png', '.PNG'),
        ];

        let found = false;
        for (const variant of variants) {
          if (bucketFiles.has(variant)) {
            newImages.push(`${storageBase}${variant}`);
            convertedUrls++;
            changed = true;
            found = true;
            break;
          }
        }

        if (!found) {
          newImages.push(img); // Keep original
          notFoundInBucket++;
          if (notFoundSamples.length < 10) notFoundSamples.push(filename);
        }
      }

      if (changed && !dryRun) {
        const { error: updateError } = await supabase
          .from('products')
          .update({ images: newImages })
          .eq('id', product.id);

        if (updateError) {
          console.error(`Error updating ${product.sku}:`, updateError);
        } else {
          fixedCount++;
        }
      } else if (changed) {
        fixedCount++;
      }
    }

    const nextOffset = offset + batch.length;
    const hasMore = batch.length === chunkSize;

    return new Response(
      JSON.stringify({
        success: true,
        dryRun,
        complete: !hasMore,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        fixedProducts: fixedCount,
        convertedUrls,
        notFoundInBucket,
        notFoundSamples,
        totalInChunk: batch.length,
        externalInChunk: toFix.length,
        bucketFileCount: bucketFiles.size / 2,
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
