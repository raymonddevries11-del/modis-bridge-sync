import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const CHECKPOINT_KEY_PREFIX = 'image_sync_checkpoint_';

interface Checkpoint {
  offset: number;
  total: number;
  processed: number;
  updated: number;
  errors: number;
  started_at: string;
  last_batch_at: string;
  tenant_id: string;
  dryRun: boolean;
  onlySupabaseUrls: boolean;
}

/**
 * Try to find a WooCommerce product by SKU.
 * Falls back to base SKU (without trailing "000") if exact match fails.
 */
async function findWooProduct(wooUrl: string, ck: string, cs: string, sku: string): Promise<any | null> {
  // Try exact SKU first
  const url1 = `${wooUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&consumer_key=${ck}&consumer_secret=${cs}`;
  const res1 = await fetch(url1);
  if (res1.ok) {
    const products = await res1.json();
    if (products?.length > 0) return products[0];
  }

  // Try base SKU without trailing "000" (common Modis pattern)
  if (sku.endsWith('000') && sku.length > 6) {
    const baseSku = sku.slice(0, -3);
    const url2 = `${wooUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(baseSku)}&consumer_key=${ck}&consumer_secret=${cs}`;
    const res2 = await fetch(url2);
    if (res2.ok) {
      const products = await res2.json();
      if (products?.length > 0) return products[0];
    }
  }

  // Try search by slug-like partial match
  const url3 = `${wooUrl}/wp-json/wc/v3/products?search=${encodeURIComponent(sku.replace(/000$/, ''))}&consumer_key=${ck}&consumer_secret=${cs}&per_page=5`;
  const res3 = await fetch(url3);
  if (res3.ok) {
    const products = await res3.json();
    const match = products?.find((p: any) => 
      p.sku === sku || p.sku === sku.replace(/000$/, '') ||
      sku.startsWith(p.sku)
    );
    if (match) return match;
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const {
      tenantId,
      dryRun = true,
      offset: requestedOffset,
      limit = 50,
      onlySupabaseUrls = false,
      resume = false,
      resetCheckpoint = false,
    } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    const checkpointKey = `${CHECKPOINT_KEY_PREFIX}${tenantId}`;

    // Handle checkpoint reset
    if (resetCheckpoint) {
      await supabase.from('config').delete().eq('key', checkpointKey);
      return new Response(
        JSON.stringify({ message: 'Checkpoint reset', key: checkpointKey }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine offset: resume from checkpoint or use provided offset
    let offset = requestedOffset ?? 0;
    let checkpoint: Checkpoint | null = null;

    if (resume) {
      const { data: cpData } = await supabase.from('config').select('value').eq('key', checkpointKey).single();
      if (cpData?.value) {
        checkpoint = cpData.value as Checkpoint;
        offset = checkpoint.offset;
        console.log(`Resuming from checkpoint: offset=${offset}, processed=${checkpoint.processed}/${checkpoint.total}`);
      } else {
        console.log('No checkpoint found, starting from beginning');
      }
    }

    // Get WooCommerce config
    const { data: config, error: cfgErr } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();
    if (cfgErr || !config) throw new Error(`No tenant config: ${cfgErr?.message}`);

    const wooUrl = config.woocommerce_url.replace(/\/$/, '');
    const ck = config.woocommerce_consumer_key;
    const cs = config.woocommerce_consumer_secret;

    // Fetch products
    let query = supabase
      .from('products')
      .select('id, sku, title, images', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('sku');

    const { data: allProducts, error: prodErr, count } = await query.range(offset, offset + limit - 1);

    const products = onlySupabaseUrls
      ? (allProducts || []).filter(p => JSON.stringify(p.images || []).includes('supabase'))
      : (allProducts || []);
    if (prodErr) throw new Error(`Failed to fetch products: ${prodErr.message}`);

    console.log(`Processing ${products.length} products (offset=${offset}, total=${count}, onlySupabase=${onlySupabaseUrls})`);

    const results: any[] = [];
    let updated = 0;
    let matched = 0;
    let notFound = 0;
    let errors = 0;
    let noImages = 0;

    const BATCH = 5;
    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);

      const promises = batch.map(async (product) => {
        try {
          const wooProduct = await findWooProduct(wooUrl, ck, cs, product.sku);

          if (!wooProduct) {
            notFound++;
            results.push({ sku: product.sku, status: 'not_found_in_woo' });
            return;
          }

          const wooImages: string[] = (wooProduct.images || [])
            .map((img: any) => img.src)
            .filter((src: string) => src && !src.includes('placeholder'));

          if (wooImages.length === 0) {
            noImages++;
            results.push({ sku: product.sku, status: 'no_woo_images' });
            return;
          }

          const currentImages = (product.images as string[]) || [];
          const alreadyMatch = currentImages.length === wooImages.length &&
            currentImages.every((img, idx) => img === wooImages[idx]);

          if (alreadyMatch) {
            matched++;
            results.push({ sku: product.sku, status: 'already_correct', imageCount: wooImages.length });
            return;
          }

          if (!dryRun) {
            const { error: updateErr } = await supabase
              .from('products')
              .update({ images: wooImages })
              .eq('id', product.id);

            if (updateErr) {
              errors++;
              results.push({ sku: product.sku, status: 'update_error', error: updateErr.message });
              return;
            }
          }

          updated++;
          results.push({
            sku: product.sku,
            status: dryRun ? 'would_update' : 'updated',
            oldCount: currentImages.length,
            newCount: wooImages.length,
            oldSample: currentImages[0],
            newSample: wooImages[0],
          });
        } catch (e) {
          errors++;
          results.push({ sku: product.sku, status: 'error', error: e.message });
        }
      });

      await Promise.all(promises);

      // Save checkpoint after each micro-batch
      const currentOffset = offset + i + batch.length;
      const cpState: Checkpoint = {
        offset: currentOffset,
        total: count || 0,
        processed: (checkpoint?.processed || 0) + batch.length,
        updated: (checkpoint?.updated || 0) + updated,
        errors: (checkpoint?.errors || 0) + errors,
        started_at: checkpoint?.started_at || new Date().toISOString(),
        last_batch_at: new Date().toISOString(),
        tenant_id: tenantId,
        dryRun,
        onlySupabaseUrls,
      };
      await supabase.from('config').upsert(
        { key: checkpointKey, value: cpState as any, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );

      if (i + BATCH < products.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const nextOffset = offset + products.length < (count || 0) ? offset + products.length : null;
    const isComplete = nextOffset === null;

    // Clear checkpoint on completion
    if (isComplete) {
      await supabase.from('config').delete().eq('key', checkpointKey);
      console.log('Sync complete — checkpoint cleared');
    }

    const summary = {
      total: count,
      processed: products.length,
      offset,
      nextOffset,
      isComplete,
      matched,
      updated,
      notFound,
      noImages,
      errors,
      dryRun,
      onlySupabaseUrls,
      resumedFrom: checkpoint ? checkpoint.offset : null,
      cumulativeProcessed: (checkpoint?.processed || 0) + products.length,
    };

    console.log('Summary:', JSON.stringify(summary));

    return new Response(
      JSON.stringify({ summary, results }, null, 2),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
