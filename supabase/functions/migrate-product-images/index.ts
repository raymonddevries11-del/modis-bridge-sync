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
    const batchSize = body.batchSize || 20;
    const offset = body.offset || 0;
    const dryRun = body.dryRun || false;

    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');

    const bucketBaseUrl = `${supabaseUrl}/storage/v1/object/public/product-images/`;

    // Get products with images
    const { data: products, error: dbErr } = await supabase
      .from('products')
      .select('id, sku, images')
      .eq('tenant_id', tenant.id)
      .not('images', 'is', null)
      .range(offset, offset + 500 - 1);
    if (dbErr) throw new Error(`DB error: ${dbErr.message}`);

    // Find products that have external (non-bucket) image URLs
    const toProcess: { id: string; sku: string; images: string[]; externalIndices: number[] }[] = [];
    for (const p of (products || [])) {
      const imgs = p.images as string[] | null;
      if (!imgs || !Array.isArray(imgs)) continue;
      const externalIndices: number[] = [];
      for (let i = 0; i < imgs.length; i++) {
        if (imgs[i] && !imgs[i].includes('product-images')) {
          externalIndices.push(i);
        }
      }
      if (externalIndices.length > 0) {
        toProcess.push({ id: p.id, sku: p.sku, images: imgs, externalIndices });
      }
    }

    // Process only batchSize products per invocation
    const batch = toProcess.slice(0, batchSize);

    const stats = { downloaded: 0, failed: 0, skipped: 0, updated: 0 };
    const errors: string[] = [];

    for (const product of batch) {
      const newImages = [...product.images];
      let changed = false;

      for (const idx of product.externalIndices) {
        const url = product.images[idx];
        if (!url) continue;

        // Extract filename from URL
        const urlParts = url.split('/');
        let filename = urlParts[urlParts.length - 1];
        // Clean query params
        if (filename.includes('?')) filename = filename.split('?')[0];
        if (!filename) { stats.skipped++; continue; }

        if (dryRun) {
          console.log(`[dry-run] Would download: ${url} -> ${filename}`);
          newImages[idx] = `${bucketBaseUrl}${filename}`;
          changed = true;
          stats.downloaded++;
          continue;
        }

        try {
          // Check if file already exists in bucket
          const { data: existing } = await supabase.storage
            .from('product-images')
            .list('', { search: filename, limit: 1 });

          if (existing && existing.length > 0 && existing[0].name === filename) {
            // File exists, just update the URL
            newImages[idx] = `${bucketBaseUrl}${filename}`;
            changed = true;
            stats.skipped++;
            continue;
          }

          // Download from external URL
          const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            redirect: 'follow',
          });

          if (!response.ok) {
            errors.push(`${product.sku}: HTTP ${response.status} for ${filename}`);
            stats.failed++;
            // Consume body to prevent leak
            await response.text();
            continue;
          }

          const contentType = response.headers.get('content-type') || 'image/jpeg';
          const blob = await response.arrayBuffer();

          if (blob.byteLength < 100) {
            stats.failed++;
            errors.push(`${product.sku}: File too small (${blob.byteLength}b) for ${filename}`);
            continue;
          }

          // Upload to bucket
          const { error: uploadErr } = await supabase.storage
            .from('product-images')
            .upload(filename, blob, {
              contentType,
              upsert: true,
            });

          if (uploadErr) {
            errors.push(`${product.sku}: Upload failed: ${uploadErr.message}`);
            stats.failed++;
            continue;
          }

          newImages[idx] = `${bucketBaseUrl}${filename}`;
          changed = true;
          stats.downloaded++;
        } catch (e) {
          errors.push(`${product.sku}: ${e instanceof Error ? e.message : 'Unknown error'}`);
          stats.failed++;
        }
      }

      // Update product images array in DB
      if (changed && !dryRun) {
        const { error: updateErr } = await supabase
          .from('products')
          .update({ images: newImages })
          .eq('id', product.id);
        if (!updateErr) stats.updated++;
        else errors.push(`${product.sku}: DB update failed: ${updateErr.message}`);
      }
    }

    const nextOffset = offset + 500;
    const hasMoreProducts = (products?.length || 0) === 500;
    const hasMoreInBatch = toProcess.length > batchSize;

    const summary = {
      success: true,
      dryRun,
      offset,
      productsScanned: products?.length || 0,
      productsWithExternalImages: toProcess.length,
      processed: batch.length,
      ...stats,
      errors: errors.slice(0, 20),
      hasMore: hasMoreProducts || hasMoreInBatch,
      nextOffset: hasMoreProducts ? nextOffset : offset,
      suggestion: hasMoreProducts
        ? `Call again with offset=${nextOffset}`
        : hasMoreInBatch
        ? `Call again with same offset=${offset} (more external images in this batch)`
        : 'All done for scanned range',
    };

    console.log('[migrate-product-images] Done:', JSON.stringify({ ...summary, errors: errors.length }));

    return new Response(JSON.stringify(summary, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[migrate-product-images] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
