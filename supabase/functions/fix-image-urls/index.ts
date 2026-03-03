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
    const enrichFromStorage = body.enrichFromStorage || false;

    // Get tenant
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');

    // Pre-fetch list of files in storage bucket
    const bucketFileMap = new Map<string, string>();
    
    async function listBucketDir(dir: string) {
      let dirOffset = 0;
      while (true) {
        const { data: files } = await supabase.storage
          .from('product-images')
          .list(dir, { limit: 1000, offset: dirOffset });
        if (!files || files.length === 0) break;
        for (const f of files) {
          if (!f.name || !f.name.includes('.')) continue;
          const fullPath = dir ? `${dir}/${f.name}` : f.name;
          const justFilename = f.name.toLowerCase();
          if (!dir) {
            bucketFileMap.set(justFilename, fullPath);
          } else if (!bucketFileMap.has(justFilename)) {
            bucketFileMap.set(justFilename, fullPath);
          }
        }
        if (files.length < 1000) break;
        dirOffset += 1000;
      }
    }
    
    await Promise.all([
      listBucketDir(''),
      listBucketDir('modis/foto'),
    ]);

    console.log(`Loaded ${bucketFileMap.size} unique filenames from storage bucket`);

    const storageBase = `${supabaseUrl}/storage/v1/object/public/product-images/`;

    // ── ENRICH MODE: scan storage for additional w-N images ──
    if (enrichFromStorage) {
      // Build reverse index: sku-base (lowercase) -> list of storage paths sorted by w-N number
      const skuBaseToFiles = new Map<string, string[]>();
      for (const [lowerName, storagePath] of bucketFileMap) {
        // Match pattern: w-{N}_{skubase}.{ext}
        const match = lowerName.match(/^w-(\d+)_(.+)\.\w+$/);
        if (!match) continue;
        const num = parseInt(match[1]);
        const skuBase = match[2];
        if (!skuBaseToFiles.has(skuBase)) skuBaseToFiles.set(skuBase, []);
        skuBaseToFiles.get(skuBase)!.push(storagePath);
      }
      // Sort each set by w-N number
      for (const [, files] of skuBaseToFiles) {
        files.sort((a, b) => {
          const na = parseInt(a.toLowerCase().match(/w-(\d+)/)?.[1] || '0');
          const nb = parseInt(b.toLowerCase().match(/w-(\d+)/)?.[1] || '0');
          return na - nb;
        });
      }

      console.log(`Built SKU-base index with ${skuBaseToFiles.size} unique bases`);

      // Get products chunk
      const { data: batch, error: batchError } = await supabase
        .from('products')
        .select('id, sku, images')
        .eq('tenant_id', tenant.id)
        .range(offset, offset + chunkSize - 1);

      if (batchError) throw batchError;
      if (!batch || batch.length === 0) {
        return new Response(JSON.stringify({
          success: true, complete: true, enriched: 0,
          message: 'No more products to process',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      let enriched = 0;
      const enrichedSamples: { sku: string; before: number; after: number }[] = [];

      for (const product of batch) {
        // Extract SKU base: strip trailing zeros (e.g. 244765001000 -> 244765001)
        const skuBase = product.sku.replace(/0{3}$/, '').toLowerCase();
        const storageFiles = skuBaseToFiles.get(skuBase);
        if (!storageFiles || storageFiles.length === 0) continue;

        const currentImages = Array.isArray(product.images) ? product.images as string[] : [];
        
        // Normalize current images to lowercase filenames for comparison
        const currentFilenames = new Set(
          currentImages.map(img => {
            if (typeof img !== 'string') return '';
            const lastSlash = Math.max(img.lastIndexOf('/'), img.lastIndexOf('\\'));
            return (lastSlash >= 0 ? img.substring(lastSlash + 1) : img).toLowerCase();
          }).filter(Boolean)
        );

        // Find storage files not yet in the product's image list
        const newFiles = storageFiles.filter(f => {
          const fname = f.split('/').pop()?.toLowerCase() || '';
          return !currentFilenames.has(fname);
        });

        if (newFiles.length === 0) continue;

        // Build complete sorted image list from storage (canonical order)
        const allStorageUrls = storageFiles.map(f => `${storageBase}${f}`);

        if (!dryRun) {
          const { error: updateError } = await supabase
            .from('products')
            .update({ images: allStorageUrls })
            .eq('id', product.id);

          if (updateError) {
            console.error(`Error enriching ${product.sku}:`, updateError);
            continue;
          }
        }

        enriched++;
        if (enrichedSamples.length < 20) {
          enrichedSamples.push({
            sku: product.sku,
            before: currentImages.length,
            after: allStorageUrls.length,
          });
        }
      }

      const nextOffset = offset + batch.length;
      const hasMore = batch.length === chunkSize;

      return new Response(JSON.stringify({
        success: true,
        dryRun,
        enrichFromStorage: true,
        complete: !hasMore,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        enriched,
        enrichedSamples,
        totalInChunk: batch.length,
        bucketFileCount: bucketFileMap.size,
        skuBasesFound: skuBaseToFiles.size,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── ORIGINAL MODE: fix external URLs ──
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

        if (img.includes('supabase.co/storage')) {
          newImages.push(img);
          continue;
        }

        let filename = '';
        if (img.includes('modis/foto')) {
          const paths = img.includes(';') ? img.split(';') : [img];
          for (const path of paths) {
            const trimmed = path.trim();
            if (!trimmed) continue;
            filename = trimmed.split('/').pop() || trimmed;
            const lookupKey = filename.toLowerCase();
            const storagePath = bucketFileMap.get(lookupKey);
            if (storagePath) {
              newImages.push(`${storageBase}${storagePath}`);
              convertedUrls++;
              changed = true;
            } else {
              newImages.push(img);
              notFoundInBucket++;
              if (notFoundSamples.length < 10) notFoundSamples.push(filename);
            }
          }
          continue;
        }

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

        const lookupKey = filename.toLowerCase();
        const storagePath = bucketFileMap.get(lookupKey);
        if (storagePath) {
          newImages.push(`${storageBase}${storagePath}`);
          convertedUrls++;
          changed = true;
        } else {
          newImages.push(img);
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
        bucketFileCount: bucketFileMap.size,
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
