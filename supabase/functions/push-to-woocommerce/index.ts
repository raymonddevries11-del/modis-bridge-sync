import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- SiteGround bot-protection hardening ---

// SiteGround triggers on rapid requests, missing browser-like headers, and non-standard User-Agents.
// We mitigate by: adaptive rate cap, realistic headers, exponential backoff on HTML blocks.

const SG_SAFE_HEADERS: Record<string, string> = {
  'User-Agent': 'ModisPIM/1.0 (WooCommerce Sync; +https://modis-bridge-sync.lovable.app)',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

// Adaptive rate limiter — increases delay when blocks are detected
class AdaptiveRateLimiter {
  private baseDelay: number;
  private currentDelay: number;
  private consecutiveBlocks = 0;
  private readonly maxDelay: number;

  constructor(baseDelayMs = 800, maxDelayMs = 5000) {
    this.baseDelay = baseDelayMs;
    this.currentDelay = baseDelayMs;
    this.maxDelay = maxDelayMs;
  }

  async wait() {
    await new Promise(r => setTimeout(r, this.currentDelay));
  }

  onSuccess() {
    this.consecutiveBlocks = 0;
    // Gradually ramp down to base delay
    this.currentDelay = Math.max(this.baseDelay, this.currentDelay * 0.8);
  }

  onBlock() {
    this.consecutiveBlocks++;
    // Double delay on each consecutive block, up to max
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
    console.warn(`Bot block detected (${this.consecutiveBlocks} consecutive). Delay now ${this.currentDelay}ms`);
  }

  get delay() { return this.currentDelay; }
  get isThrottled() { return this.consecutiveBlocks >= 3; }
}

function isHtmlResponse(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  return lower.startsWith('<html') || lower.startsWith('<!doctype') || lower.includes('sgcapt') || lower.includes('captcha');
}

interface FetchResult {
  response: Response;
  text: string;
  json: any | null;
  blocked: boolean;
}

async function fetchWithRetry(url: string, options: RequestInit, rateLimiter: AdaptiveRateLimiter, maxRetries = 4): Promise<FetchResult> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
      console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          ...SG_SAFE_HEADERS,
          ...options.headers as Record<string, string>,
        },
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5') * 1000;
        console.log(`Rate limited (429), waiting ${retryAfter}ms`);
        rateLimiter.onBlock();
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }

      const text = await res.text();

      if (isHtmlResponse(text)) {
        console.warn(`Attempt ${attempt + 1}: HTML/bot-protection (${text.length} bytes, status ${res.status})`);
        rateLimiter.onBlock();
        if (attempt < maxRetries - 1) continue;
        return { response: res, text, json: null, blocked: true };
      }

      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }

      rateLimiter.onSuccess();
      return { response: res, text, json, blocked: false };
    } catch (e) {
      lastError = e as Error;
      console.error(`Fetch attempt ${attempt + 1} failed:`, lastError.message);
    }
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
    const rateLimiter = new AdaptiveRateLimiter(800, 5000);

    // Get PIM products with all related data
    const { data: pimProducts, error: pimErr } = await supabase
      .from('products')
      .select(`
        id, sku, title, webshop_text, meta_title, meta_description, images, categories, attributes, url_key,
        brands!products_brand_id_fkey (name),
        product_prices (regular, list),
        variants (id, size_label, maat_id, ean, active, stock_totals (qty)),
        product_ai_content!product_ai_content_product_id_fkey (
          status, ai_title, ai_short_description, ai_long_description,
          ai_meta_title, ai_meta_description
        )
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
        const searchResult = await fetchWithRetry(searchUrl, { method: 'GET' }, rateLimiter);

        if (searchResult.blocked) {
          results.push({ sku: pim.sku, action: 'error', changes: [], message: 'Blocked by hosting bot protection (all retries exhausted)' });
          continue;
        }
        if (!searchResult.response.ok) {
          results.push({ sku: pim.sku, action: 'error', changes: [], message: `Search failed: ${searchResult.response.status}` });
          continue;
        }
        if (!searchResult.json) {
          results.push({ sku: pim.sku, action: 'error', changes: [], message: 'WooCommerce returned non-JSON response' });
          continue;
        }

        const wooProducts = searchResult.json;
        const prices = pim.product_prices as any;
        const brand = (pim.brands as any)?.name || null;
        const regularPrice = prices?.regular?.toString() || '';
        const salePrice = prices?.list?.toString() || '';
        const sizeOptions = (pim.variants || []).filter((v: any) => v.active).map((v: any) => v.size_label);

        // Determine if this is a variable product (has active variants with sizes)
        const isVariable = sizeOptions.length > 0;

        // Use approved AI content if available, fallback to PIM data
        const aiContent = (pim.product_ai_content as any);
        const hasApprovedAi = aiContent?.status === 'approved';

        const productName = (hasApprovedAi && aiContent.ai_title) || pim.title;
        const longDescription = (hasApprovedAi && aiContent.ai_long_description) || pim.webshop_text || '';
        const shortDescription = (hasApprovedAi && aiContent.ai_short_description) || '';
        const metaTitle = (hasApprovedAi && aiContent.ai_meta_title) || pim.meta_title;
        const metaDescription = (hasApprovedAi && aiContent.ai_meta_description) || pim.meta_description;

        if (hasApprovedAi) {
          console.log(`Using approved AI content for ${pim.sku}: title="${productName}"`);
        }

        // Build desired WooCommerce data
        const desiredData: Record<string, any> = {
          name: productName,
          description: longDescription,
          short_description: shortDescription,
          sku: pim.sku,
          slug: pim.url_key || undefined,
          meta_data: [
            ...(metaTitle ? [{ key: '_yoast_wpseo_title', value: metaTitle }] : []),
            ...(metaDescription ? [{ key: '_yoast_wpseo_metadesc', value: metaDescription }] : []),
          ],
        };

        // Only set prices on simple products — variable products get prices on variations
        if (!isVariable) {
          desiredData.regular_price = regularPrice;
          desiredData.sale_price = salePrice;
        }

        // Build images array — only include valid full URLs
        const pimImages = Array.isArray(pim.images) ? pim.images : [];
        const validImages = pimImages
          .map((img: any) => typeof img === 'string' ? img : img.url || img.src)
          .filter((src: string) => src && (src.startsWith('http://') || src.startsWith('https://')));
        if (validImages.length > 0) {
          desiredData.images = validImages.map((src: string, idx: number) => ({
            src,
            position: idx,
          }));
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
          const createResult = await fetchWithRetry(createUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(desiredData),
          }, rateLimiter);

          if (createResult.blocked) {
            results.push({ sku: pim.sku, action: 'error', changes: [], message: 'Create blocked by hosting bot protection (all retries exhausted)' });
          } else if (!createResult.response.ok || !createResult.json) {
            results.push({ sku: pim.sku, action: 'error', changes: [], message: `Create failed: ${(createResult.text || '').substring(0, 200)}` });
          } else {
            const created = createResult.json;
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

            // Log field-level changes to woo_product_changes
            const { data: upsertedWoo } = await supabase
              .from('woo_products')
              .select('id')
              .eq('tenant_id', tenantId)
              .eq('woo_id', created.id)
              .single();

            if (upsertedWoo) {
              const changeEntries = allChanges.map(c => ({
                tenant_id: tenantId,
                woo_product_id: upsertedWoo.id,
                woo_id: created.id,
                sku: pim.sku,
                product_name: pim.title,
                change_type: 'push_create',
                field_name: c.field,
                old_value: c.old_value,
                new_value: c.new_value,
                detected_at: new Date().toISOString(),
              }));
              await supabase.from('woo_product_changes').insert(changeEntries);
            }

            results.push({ sku: pim.sku, action: 'created', changes: allChanges, message: `Created WC #${created.id}` });
          }
        } else {
          // UPDATE existing product — compare fields
          const woo = wooProducts[0];
          const changes: FieldChange[] = [];

          // Compare core fields
          if (woo.name !== desiredData.name) changes.push({ field: 'name', old_value: woo.name, new_value: desiredData.name });
          if ((woo.description || '') !== (desiredData.description || '')) changes.push({ field: 'description', old_value: (woo.description || '').substring(0, 50), new_value: (desiredData.description || '').substring(0, 50) });
          if (!isVariable && (woo.regular_price || '') !== regularPrice) changes.push({ field: 'regular_price', old_value: woo.regular_price || '', new_value: regularPrice });
          if (!isVariable && (woo.sale_price || '') !== salePrice) changes.push({ field: 'sale_price', old_value: woo.sale_price || '', new_value: salePrice });
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
          const updateResult = await fetchWithRetry(updateUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(desiredData),
          }, rateLimiter);

          if (updateResult.blocked) {
            results.push({ sku: pim.sku, action: 'error', changes, message: 'Update blocked by hosting bot protection (all retries exhausted)' });
          } else if (!updateResult.response.ok || !updateResult.json) {
            results.push({ sku: pim.sku, action: 'error', changes, message: `Update failed: ${updateResult.response.status} - ${(updateResult.text || '').substring(0, 150)}` });
          } else {
            const updated = updateResult.json;

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

            // Log field-level changes to woo_product_changes
            const { data: upsertedWooUpdate } = await supabase
              .from('woo_products')
              .select('id')
              .eq('tenant_id', tenantId)
              .eq('woo_id', updated.id)
              .single();

            if (upsertedWooUpdate) {
              const changeEntries = changes.map(c => ({
                tenant_id: tenantId,
                woo_product_id: upsertedWooUpdate.id,
                woo_id: updated.id,
                sku: pim.sku,
                product_name: pim.title,
                change_type: 'push_update',
                field_name: c.field,
                old_value: c.old_value,
                new_value: c.new_value,
                detected_at: new Date().toISOString(),
              }));
              await supabase.from('woo_product_changes').insert(changeEntries);
            }

            results.push({ sku: pim.sku, action: 'updated', changes, message: `Updated ${changes.length} fields on WC #${woo.id}` });
          }
        }

        // Adaptive rate limit — slows down when blocks are detected
        await rateLimiter.wait();

        // Abort early if SiteGround is persistently blocking
        if (rateLimiter.isThrottled) {
          console.error('SiteGround bot protection is persistently blocking requests. Aborting remaining products.');
          results.push(...pimProducts.slice(pimProducts.indexOf(pim) + 1).map((p: any) => ({
            sku: p.sku, action: 'error' as const, changes: [],
            message: 'Skipped — SiteGround bot protection persistently blocking',
          })));
          break;
        }
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
