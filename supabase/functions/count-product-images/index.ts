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

    // Get tenant
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');

    // 1. Count files in storage bucket (paginate through all)
    const bucketFiles = new Set<string>();
    let storageOffset = 0;
    const storageLimit = 1000;
    while (true) {
      const { data: files, error } = await supabase.storage
        .from('product-images')
        .list('', { limit: storageLimit, offset: storageOffset });
      if (error) throw new Error(`Storage list error: ${error.message}`);
      if (!files || files.length === 0) break;
      for (const f of files) {
        if (f.name && !f.name.startsWith('.')) bucketFiles.add(f.name);
      }
      if (files.length < storageLimit) break;
      storageOffset += storageLimit;
    }

    // Also check subdirectories
    const subDirs = [...bucketFiles].filter(f => !f.includes('.'));
    const actualFiles = new Set([...bucketFiles].filter(f => f.includes('.')));

    for (const dir of subDirs) {
      let dirOffset = 0;
      while (true) {
        const { data: files, error } = await supabase.storage
          .from('product-images')
          .list(dir, { limit: storageLimit, offset: dirOffset });
        if (error) break;
        if (!files || files.length === 0) break;
        for (const f of files) {
          if (f.name && f.name.includes('.')) actualFiles.add(`${dir}/${f.name}`);
        }
        if (files.length < storageLimit) break;
        dirOffset += storageLimit;
      }
    }

    // 2. Get all image URLs from products table
    const dbImageUrls = new Set<string>();
    let dbOffset = 0;
    const dbLimit = 1000;
    while (true) {
      const { data: products, error } = await supabase
        .from('products')
        .select('sku, images')
        .eq('tenant_id', tenant.id)
        .not('images', 'is', null)
        .range(dbOffset, dbOffset + dbLimit - 1);
      if (error) throw new Error(`DB query error: ${error.message}`);
      if (!products || products.length === 0) break;
      for (const p of products) {
        const imgs = p.images as string[] | null;
        if (imgs && Array.isArray(imgs)) {
          for (const url of imgs) {
            if (url) dbImageUrls.add(url);
          }
        }
      }
      if (products.length < dbLimit) break;
      dbOffset += dbLimit;
    }

    // 3. Analyze: which DB images point to bucket vs external
    let dbPointsToBucket = 0;
    let dbPointsExternal = 0;
    const bucketBaseUrl = `${supabaseUrl}/storage/v1/object/public/product-images/`;

    for (const url of dbImageUrls) {
      if (url.includes('product-images')) {
        dbPointsToBucket++;
      } else {
        dbPointsExternal++;
      }
    }

    const summary = {
      storage: {
        totalFilesInBucket: actualFiles.size,
        directories: subDirs.length,
      },
      database: {
        totalImageReferences: dbImageUrls.size,
        pointingToBucket: dbPointsToBucket,
        pointingToExternal: dbPointsExternal,
        productsWithImages: dbOffset > 0 ? 'more than ' + dbOffset : 'counted',
      },
      sampleBucketFiles: [...actualFiles].slice(0, 10),
      sampleDbUrls: [...dbImageUrls].slice(0, 5),
    };

    console.log('[count-product-images] Result:', JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[count-product-images] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
