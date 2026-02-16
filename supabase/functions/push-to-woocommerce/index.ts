import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 5000)));
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        const delay = parseInt(res.headers.get('Retry-After') || '5') * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) { lastError = e as Error; }
  }
  throw lastError || new Error('All fetch attempts failed');
}

interface FieldChange {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { tenantId, productIds } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');
    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      throw new Error('productIds array is required');
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Get WooCommerce config
    const { data: config, error: cfgErr } = await supabase
      .from('tenant_config')
      .select('woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret')
      .eq('tenant_id', tenantId)
      .single();
    if (cfgErr || !config) throw new Error(`Config not found: ${cfgErr?.message}`);

    const wooAuth = `consumer_key=${config.woocommerce_consumer_key}&consumer_secret=${config.woocommerce_consumer_secret}`;

    // Get PIM products with all related data
    const { data: pimProducts, error: pimErr } = await supabase
      .from('products')
      .select(`
        id, sku, title, webshop_text, meta_title, meta_description, images, categories, attributes, url_key,
        brands!products_brand_id_fkey (name),
        product_prices (regular, list),
        variants (id, size_label, maat_id, ean, active, stock_totals (qty))
      `)
      .in('id', productIds)
      .eq('tenant_id', tenantId);

    if (pimErr) throw new Error(`Failed to fetch PIM products: ${pimErr.message}`);
    if (!pimProducts || pimProducts.length === 0) throw new Error('No PIM products found');

    // Get category mappings
    const { data: catMappings } = await supabase
      .from('woo_category_mappings')
      .select('source_category, woo_category')
      .eq('tenant_id', tenantId);

    const catMap = new Map<string, string>();
    if (catMappings) catMappings.forEach(m => catMap.set(m.source_category, m.woo_category));

    const results: Array<{
      sku: string;
      action: 'created' | 'updated' | 'skipped' | 'error';
      changes: FieldChange[];
      message: string;
    }> = [];

    for (const pim of pimProducts) {
      try {
        // Search WooCommerce for this SKU
        const searchUrl = `${config.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(pim.sku)}&${wooAuth}`;
        const searchRes = await fetchWithRetry(searchUrl, { headers: { 'Content-Type': 'application/json' } });

        if (!searchRes.ok) {
          const text = await searchRes.text();
          if (text.includes('sgcapt') || text.includes('<html')) {
            results.push({ sku: pim.sku, action: 'error', changes: [], message: 'Blocked by hosting bot protection' });
            continue;
          }
          results.push({ sku: pim.sku, action: 'error', changes: [], message: `Search failed: ${searchRes.status}` });
          continue;
        }

        const wooProducts = await searchRes.json();
        const prices = pim.product_prices as any;
        const brand = (pim.brands as any)?.name || null;
        const regularPrice = prices?.regular?.toString() || '';
        const salePrice = prices?.list?.toString() || '';
        const sizeOptions = (pim.variants || []).filter((v: any) => v.active).map((v: any) => v.size_label);

        // Build desired WooCommerce data
        const desiredData: Record<string, any> = {
          name: pim.title,
          description: pim.webshop_text || '',
          short_description: '',
          regular_price: regularPrice,
          sale_price: salePrice,
          sku: pim.sku,
          slug: pim.url_key || undefined,
          meta_data: [
            ...(pim.meta_title ? [{ key: '_yoast_wpseo_title', value: pim.meta_title }] : []),
            ...(pim.meta_description ? [{ key: '_yoast_wpseo_metadesc', value: pim.meta_description }] : []),
          ],
        };

        // Build images array
        const pimImages = Array.isArray(pim.images) ? pim.images : [];
        if (pimImages.length > 0) {
          desiredData.images = pimImages.map((img: any, idx: number) => ({
            src: typeof img === 'string' ? img : img.url || img.src,
            position: idx,
          })).filter((img: any) => img.src);
        }

        // Build attributes
        const attrs: any[] = [];
        if (sizeOptions.length > 0) {
          attrs.push({ name: 'Maat', position: 0, visible: true, variation: true, options: sizeOptions });
        }
        if (pim.attributes && typeof pim.attributes === 'object') {
          const pimAttrs = pim.attributes as Record<string, any>;
          let pos = 1;
          for (const [key, val] of Object.entries(pimAttrs)) {
            if (val) {
              attrs.push({ name: key, position: pos++, visible: true, variation: false, options: [String(val)] });
            }
          }
        }
        if (brand) {
          attrs.push({ name: 'Merk', position: attrs.length, visible: true, variation: false, options: [brand] });
        }
        if (attrs.length > 0) desiredData.attributes = attrs;

        if (!wooProducts || wooProducts.length === 0) {
          // CREATE new product
          desiredData.type = sizeOptions.length > 0 ? 'variable' : 'simple';
          desiredData.status = 'publish';

          const createUrl = `${config.woocommerce_url}/wp-json/wc/v3/products?${wooAuth}`;
          const createRes = await fetchWithRetry(createUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(desiredData),
          });

          if (!createRes.ok) {
            const errBody = await createRes.text();
            results.push({ sku: pim.sku, action: 'error', changes: [], message: `Create failed: ${errBody.substring(0, 200)}` });
          } else {
            const created = await createRes.json();
            const allChanges: FieldChange[] = [
              { field: 'name', old_value: null, new_value: pim.title },
              { field: 'regular_price', old_value: null, new_value: regularPrice },
              ...(salePrice ? [{ field: 'sale_price', old_value: null, new_value: salePrice }] : []),
              ...(pimImages.length > 0 ? [{ field: 'images', old_value: null, new_value: `${pimImages.length} afbeeldingen` }] : []),
            ];

            // Update woo_products table
            await supabase.from('woo_products').upsert({
              tenant_id: tenantId,
              woo_id: created.id,
              product_id: pim.id,
              sku: pim.sku,
              name: pim.title,
              slug: created.slug,
              permalink: created.permalink,
              status: created.status,
              stock_status: created.stock_status,
              regular_price: regularPrice,
              sale_price: salePrice,
              categories: created.categories || [],
              tags: created.tags || [],
              images: (created.images || []).map((img: any) => ({ id: img.id, src: img.src, alt: img.alt })),
              type: created.type,
              last_fetched_at: new Date().toISOString(),
              last_pushed_at: new Date().toISOString(),
              last_push_changes: { action: 'created', fields: allChanges, pushed_at: new Date().toISOString() },
            }, { onConflict: 'tenant_id,woo_id' });

            results.push({ sku: pim.sku, action: 'created', changes: allChanges, message: `Created WC #${created.id}` });
          }
        } else {
          // UPDATE existing product — compare fields
          const woo = wooProducts[0];
          const changes: FieldChange[] = [];

          // Compare core fields
          if (woo.name !== desiredData.name) changes.push({ field: 'name', old_value: woo.name, new_value: desiredData.name });
          if ((woo.description || '') !== (desiredData.description || '')) changes.push({ field: 'description', old_value: (woo.description || '').substring(0, 50), new_value: (desiredData.description || '').substring(0, 50) });
          if ((woo.regular_price || '') !== regularPrice) changes.push({ field: 'regular_price', old_value: woo.regular_price || '', new_value: regularPrice });
          if ((woo.sale_price || '') !== salePrice) changes.push({ field: 'sale_price', old_value: woo.sale_price || '', new_value: salePrice });
          if (woo.slug !== desiredData.slug && desiredData.slug) changes.push({ field: 'slug', old_value: woo.slug, new_value: desiredData.slug });

          // Compare images count
          const wooImgCount = (woo.images || []).length;
          const pimImgCount = desiredData.images?.length || 0;
          if (pimImgCount > 0 && wooImgCount !== pimImgCount) {
            changes.push({ field: 'images', old_value: `${wooImgCount} afbeeldingen`, new_value: `${pimImgCount} afbeeldingen` });
          }

          // Compare attributes
          const wooAttrNames = (woo.attributes || []).map((a: any) => a.name).sort().join(',');
          const pimAttrNames = (desiredData.attributes || []).map((a: any) => a.name).sort().join(',');
          if (wooAttrNames !== pimAttrNames) {
            changes.push({ field: 'attributes', old_value: wooAttrNames || 'geen', new_value: pimAttrNames || 'geen' });
          }

          if (changes.length === 0) {
            // Update woo_products record even if no changes (to track last check)
            await supabase.from('woo_products').upsert({
              tenant_id: tenantId,
              woo_id: woo.id,
              product_id: pim.id,
              sku: pim.sku,
              name: woo.name,
              slug: woo.slug,
              permalink: woo.permalink,
              status: woo.status,
              stock_status: woo.stock_status,
              stock_quantity: woo.stock_quantity,
              regular_price: woo.regular_price,
              sale_price: woo.sale_price,
              categories: woo.categories || [],
              tags: woo.tags || [],
              images: (woo.images || []).map((img: any) => ({ id: img.id, src: img.src, alt: img.alt })),
              type: woo.type,
              last_fetched_at: new Date().toISOString(),
              last_pushed_at: new Date().toISOString(),
              last_push_changes: { action: 'checked', fields: [], pushed_at: new Date().toISOString(), message: 'No changes detected' },
            }, { onConflict: 'tenant_id,woo_id' });

            results.push({ sku: pim.sku, action: 'skipped', changes: [], message: 'No changes detected' });
            continue;
          }

          // Apply update
          const updateUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/${woo.id}?${wooAuth}`;
          const updateRes = await fetchWithRetry(updateUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(desiredData),
          });

          if (!updateRes.ok) {
            results.push({ sku: pim.sku, action: 'error', changes, message: `Update failed: ${updateRes.status}` });
          } else {
            const updated = await updateRes.json();

            await supabase.from('woo_products').upsert({
              tenant_id: tenantId,
              woo_id: updated.id,
              product_id: pim.id,
              sku: pim.sku,
              name: updated.name,
              slug: updated.slug,
              permalink: updated.permalink,
              status: updated.status,
              stock_status: updated.stock_status,
              stock_quantity: updated.stock_quantity,
              regular_price: updated.regular_price,
              sale_price: updated.sale_price,
              categories: updated.categories || [],
              tags: updated.tags || [],
              images: (updated.images || []).map((img: any) => ({ id: img.id, src: img.src, alt: img.alt })),
              type: updated.type,
              last_fetched_at: new Date().toISOString(),
              last_pushed_at: new Date().toISOString(),
              last_push_changes: { action: 'updated', fields: changes, pushed_at: new Date().toISOString() },
            }, { onConflict: 'tenant_id,woo_id' });

            results.push({ sku: pim.sku, action: 'updated', changes, message: `Updated ${changes.length} fields on WC #${woo.id}` });
          }
        }

        // Rate limit delay
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        results.push({ sku: pim.sku, action: 'error', changes: [], message: e instanceof Error ? e.message : 'Unknown error' });
      }
    }

    // Log to changelog
    const created = results.filter(r => r.action === 'created').length;
    const updated = results.filter(r => r.action === 'updated').length;
    const errors = results.filter(r => r.action === 'error').length;
    const skipped = results.filter(r => r.action === 'skipped').length;

    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_PRODUCT_PUSH',
      description: `Push naar WooCommerce: ${created} aangemaakt, ${updated} bijgewerkt, ${skipped} ongewijzigd, ${errors} fouten`,
      metadata: { results: results.slice(0, 50), totals: { created, updated, skipped, errors } },
    });

    console.log(`Push complete: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`);

    return new Response(JSON.stringify({
      success: true,
      totals: { created, updated, skipped, errors },
      results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Push error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
