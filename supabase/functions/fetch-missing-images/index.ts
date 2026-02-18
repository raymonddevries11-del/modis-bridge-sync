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
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const tenantSlug = body.tenant || 'kosterschoenmode';
    const batchSize = Math.min(body.batchSize || 50, 100);
    const dryRun = body.dryRun ?? false;

    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');

    const bucketBase = `${supabaseUrl}/storage/v1/object/public/product-images/`;

    // Step 1: Get ALL products with images, paginated
    const allProducts: { id: string; sku: string; images: string[] }[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('products')
        .select('id, sku, images')
        .eq('tenant_id', tenant.id)
        .not('images', 'is', null)
        .order('sku')
        .range(offset, offset + 999);
      if (error) throw new Error(`DB error: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const p of data) {
        const imgs = p.images as string[] | null;
        if (!imgs || !Array.isArray(imgs) || imgs.length === 0) continue;
        // Check if any image is non-bucket
        const hasNonBucket = imgs.some((img: string) => 
          typeof img === 'string' && img && !img.includes('supabase.co/storage')
        );
        if (hasNonBucket) {
          allProducts.push({ id: p.id, sku: p.sku, images: imgs });
        }
      }
      if (data.length < 1000) break;
      offset += 1000;
    }

    console.log(`Found ${allProducts.length} products with non-bucket images`);

    // Step 2: Get woo_products for these products (batch lookup)
    const productIds = allProducts.map(p => p.id);
    const wooMap = new Map<string, { src: string; name?: string }[]>();
    
    for (let i = 0; i < productIds.length; i += 200) {
      const batch = productIds.slice(i, i + 200);
      const { data: wooData } = await supabase
        .from('woo_products')
        .select('product_id, images')
        .in('product_id', batch)
        .not('images', 'is', null);
      
      if (wooData) {
        for (const wp of wooData) {
          if (!wp.product_id) continue;
          const wcImgs = (wp.images as any[] || []).filter((i: any) => i?.src);
          if (wcImgs.length > 0) {
            wooMap.set(wp.product_id, wcImgs);
          }
        }
      }
    }

    console.log(`Found WC images for ${wooMap.size} products`);

    // Step 3: Build list of products to fix
    interface ToFix {
      id: string;
      sku: string;
      images: string[];
      missingIndices: number[];
      wcImages: { src: string; name?: string }[];
    }

    const toFix: ToFix[] = [];
    for (const p of allProducts) {
      const missingIndices: number[] = [];
      for (let i = 0; i < p.images.length; i++) {
        const img = p.images[i];
        if (!img || typeof img !== 'string') continue;
        if (img.includes('supabase.co/storage')) continue;
        missingIndices.push(i);
      }
      if (missingIndices.length === 0) continue;

      const wcImages = wooMap.get(p.id);
      if (!wcImages || wcImages.length === 0) continue;

      toFix.push({ id: p.id, sku: p.sku, images: p.images, missingIndices, wcImages });
    }

    console.log(`${toFix.length} products fixable from WC`);

    const batch = toFix.slice(0, batchSize);
    const stats = { processed: 0, downloaded: 0, updated: 0, skipped: 0, failed: 0 };
    const errors: string[] = [];
    const results: { sku: string; status: string; fixed: number }[] = [];

    for (const product of batch) {
      stats.processed++;

      // Build WC image map: lowercase base filename -> src URL
      const wcMap = new Map<string, string>();
      for (const wcImg of product.wcImages) {
        const wcFilename = wcImg.src.split('/').pop()?.split('?')[0] || '';
        const wcBase = wcFilename.replace(/\.\w+$/, '').replace(/-\d+x\d+$/, '').toLowerCase();
        wcMap.set(wcBase, wcImg.src);
      }

      const newImages = [...product.images];
      let changed = false;
      let fixedCount = 0;

      for (const idx of product.missingIndices) {
        const origUrl = product.images[idx];
        let filename = origUrl.split('/').pop() || '';
        if (filename.includes('?')) filename = filename.split('?')[0];
        const fileBase = filename.replace(/\.\w+$/, '').toLowerCase();

        // Try exact match
        let wcSrc = wcMap.get(fileBase);

        // Try article number match (W-1_233761111 -> look for anything with 233761111)
        if (!wcSrc) {
          const articleMatch = fileBase.match(/w-(\d+)_(\d+)/);
          if (articleMatch) {
            const imgNum = parseInt(articleMatch[1]);
            const articleNum = articleMatch[2];
            // Find WC image that matches this article and image number
            for (const [wcBase, wcUrl] of wcMap) {
              if (wcBase.includes(articleNum) && wcBase.includes(`w-${imgNum}`)) {
                wcSrc = wcUrl;
                break;
              }
            }
            // Fallback: any WC image with this article number, pick by position
            if (!wcSrc) {
              const articleImages = [...wcMap.entries()]
                .filter(([k]) => k.includes(articleNum))
                .sort(([a], [b]) => a.localeCompare(b));
              if (articleImages.length > 0 && imgNum <= articleImages.length) {
                wcSrc = articleImages[imgNum - 1]?.[1];
              }
            }
          }
        }

        // Fallback: if only one WC image and one missing, use it
        if (!wcSrc && product.wcImages.length === 1 && product.missingIndices.length === 1) {
          wcSrc = product.wcImages[0].src;
        }

        // Fallback: match by position (W-N -> Nth WC image)
        if (!wcSrc) {
          const posMatch = fileBase.match(/w-(\d+)/);
          if (posMatch) {
            const imgNum = parseInt(posMatch[1]);
            if (imgNum <= product.wcImages.length) {
              wcSrc = product.wcImages[imgNum - 1]?.src;
            }
          }
        }

        if (!wcSrc) {
          stats.skipped++;
          continue;
        }

        if (dryRun) {
          fixedCount++;
          stats.downloaded++;
          continue;
        }

        // Download from WC and upload to bucket
        try {
          const response = await fetch(wcSrc, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            redirect: 'follow',
          });
          if (!response.ok) {
            stats.failed++;
            errors.push(`${product.sku}: HTTP ${response.status} for ${filename}`);
            continue;
          }

          const blob = await response.arrayBuffer();
          if (blob.byteLength < 100) {
            stats.failed++;
            continue;
          }

          // Normalize filename to lowercase
          const normalizedFilename = filename.toLowerCase().replace(/\.jpeg$/, '.jpg');
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          const { error: uploadErr } = await supabase.storage
            .from('product-images')
            .upload(normalizedFilename, blob, { contentType, upsert: true });

          if (uploadErr) {
            stats.failed++;
            errors.push(`${product.sku}: Upload error: ${uploadErr.message}`);
            continue;
          }

          newImages[idx] = `${bucketBase}${normalizedFilename}`;
          changed = true;
          fixedCount++;
          stats.downloaded++;
        } catch (e) {
          stats.failed++;
          errors.push(`${product.sku}: ${e instanceof Error ? e.message : 'Unknown'}`);
        }
      }

      if (changed && !dryRun) {
        const { error: updateErr } = await supabase
          .from('products').update({ images: newImages }).eq('id', product.id);
        if (!updateErr) stats.updated++;
        else errors.push(`${product.sku}: DB update failed`);
      }

      results.push({ sku: product.sku, status: changed ? 'fixed' : (fixedCount > 0 ? 'dry_run' : 'no_match'), fixed: fixedCount });
    }

    return new Response(JSON.stringify({
      success: true,
      dryRun,
      totalWithMissing: allProducts.length,
      totalFixable: toFix.length,
      ...stats,
      errors: errors.slice(0, 20),
      results,
    }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('fetch-missing-images error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
