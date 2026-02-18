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

    // Step 1: Build a set of all filenames that exist in storage (case-sensitive)
    console.log('Building storage file index...');
    const storageFiles = new Set<string>();
    let storageOffset = 0;
    while (true) {
      const { data } = await supabase.storage
        .from('product-images')
        .list('', { limit: 1000, offset: storageOffset });
      if (!data || data.length === 0) break;
      for (const f of data) {
        if (f.name && !f.name.startsWith('.')) storageFiles.add(f.name);
      }
      if (data.length < 1000) break;
      storageOffset += 1000;
    }
    // Also list modis/foto/ subdir
    storageOffset = 0;
    while (true) {
      const { data } = await supabase.storage
        .from('product-images')
        .list('modis/foto', { limit: 1000, offset: storageOffset });
      if (!data || data.length === 0) break;
      for (const f of data) {
        if (f.name && !f.name.startsWith('.')) storageFiles.add(`modis/foto/${f.name}`);
      }
      if (data.length < 1000) break;
      storageOffset += 1000;
    }
    console.log(`Storage index: ${storageFiles.size} files`);

    // Step 2: Get ALL products with images, find ones with broken refs
    const allBroken: { id: string; sku: string; images: string[]; brokenIndices: number[] }[] = [];
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
        const brokenIndices: number[] = [];
        for (let i = 0; i < imgs.length; i++) {
          const img = imgs[i];
          if (!img || typeof img !== 'string') continue;
          
          // Case 1: non-bucket URL (relative path, WC URL, etc.)
          if (!img.includes('supabase.co/storage')) {
            brokenIndices.push(i);
            continue;
          }
          
          // Case 2: bucket URL but file doesn't exist
          const path = img.replace(bucketBase, '');
          if (path && !storageFiles.has(path)) {
            brokenIndices.push(i);
          }
        }
        if (brokenIndices.length > 0) {
          allBroken.push({ id: p.id, sku: p.sku, images: imgs, brokenIndices });
        }
      }
      if (data.length < 1000) break;
      offset += 1000;
    }

    console.log(`Found ${allBroken.length} products with broken image refs`);

    // Step 3: Get woo_products for these products
    const productIds = allBroken.map(p => p.id);
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

    // Step 4: Build fix list (only products with WC images)
    interface ToFix {
      id: string;
      sku: string;
      images: string[];
      brokenIndices: number[];
      wcImages: { src: string; name?: string }[];
    }

    const toFix: ToFix[] = [];
    for (const p of allBroken) {
      const wcImages = wooMap.get(p.id);
      if (!wcImages || wcImages.length === 0) continue;
      toFix.push({ ...p, wcImages });
    }

    console.log(`${toFix.length} products fixable from WC`);

    const batch = toFix.slice(0, batchSize);
    const stats = { processed: 0, downloaded: 0, updated: 0, skipped: 0, failed: 0 };
    const errors: string[] = [];
    const results: { sku: string; status: string; fixed: number }[] = [];

    for (const product of batch) {
      stats.processed++;

      // Build WC image map
      const wcMap = new Map<string, string>();
      for (const wcImg of product.wcImages) {
        const wcFilename = wcImg.src.split('/').pop()?.split('?')[0] || '';
        const wcBase = wcFilename.replace(/\.\w+$/, '').replace(/-\d+x\d+$/, '').toLowerCase();
        wcMap.set(wcBase, wcImg.src);
      }

      const newImages = [...product.images];
      let changed = false;
      let fixedCount = 0;

      for (const idx of product.brokenIndices) {
        const origUrl = product.images[idx];
        let filename = origUrl.split('/').pop() || '';
        if (filename.includes('?')) filename = filename.split('?')[0];
        const fileBase = filename.replace(/\.\w+$/, '').toLowerCase();

        let wcSrc = wcMap.get(fileBase);

        // Article number match
        if (!wcSrc) {
          const articleMatch = fileBase.match(/w-(\d+)_(\d+)/);
          if (articleMatch) {
            const imgNum = parseInt(articleMatch[1]);
            const articleNum = articleMatch[2];
            for (const [wcBase, wcUrl] of wcMap) {
              if (wcBase.includes(articleNum) && wcBase.includes(`w-${imgNum}`)) {
                wcSrc = wcUrl;
                break;
              }
            }
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

        // Single image fallback
        if (!wcSrc && product.wcImages.length === 1 && product.brokenIndices.length === 1) {
          wcSrc = product.wcImages[0].src;
        }

        // Position fallback
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

      results.push({
        sku: product.sku,
        status: changed ? 'fixed' : (fixedCount > 0 ? 'dry_run' : 'no_match'),
        fixed: fixedCount,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      dryRun,
      totalBroken: allBroken.length,
      totalFixable: toFix.length,
      totalUnfixable: allBroken.length - toFix.length,
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
