import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- SiteGround bot-protection hardening ---

const SG_SAFE_HEADERS: Record<string, string> = {
  'User-Agent': 'ModisPIM/1.0 (WooCommerce Sync; +https://modis-bridge-sync.lovable.app)',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

// --- Circuit Breaker ---
const CIRCUIT_BREAKER_KEY = 'woo_sync_circuit_breaker';
const BLOCK_THRESHOLD = 5; // consecutive blocks before pausing

interface CircuitBreakerState {
  paused: boolean;
  consecutive_blocks: number;
  paused_at: string | null;
  last_block_at: string | null;
  total_blocks_24h: number;
}

async function getCircuitBreaker(supabase: any): Promise<CircuitBreakerState> {
  const { data } = await supabase.from('config').select('value').eq('key', CIRCUIT_BREAKER_KEY).single();
  if (data?.value) return data.value as CircuitBreakerState;
  return { paused: false, consecutive_blocks: 0, paused_at: null, last_block_at: null, total_blocks_24h: 0 };
}

async function updateCircuitBreaker(supabase: any, state: CircuitBreakerState) {
  await supabase.from('config').upsert({ key: CIRCUIT_BREAKER_KEY, value: state, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

async function recordBlock(supabase: any, tenantId: string): Promise<CircuitBreakerState> {
  const state = await getCircuitBreaker(supabase);
  state.consecutive_blocks++;
  state.last_block_at = new Date().toISOString();
  state.total_blocks_24h++;

  if (state.consecutive_blocks >= BLOCK_THRESHOLD) {
    state.paused = true;
    state.paused_at = new Date().toISOString();
    console.error(`🛑 Circuit breaker TRIPPED: ${state.consecutive_blocks} consecutive blocks. Sync paused.`);

    // Log alert to changelog
    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_SYNC_PAUSED',
      description: `Sync automatisch gepauzeerd: ${state.consecutive_blocks} opeenvolgende bot-blocks gedetecteerd`,
      metadata: { circuit_breaker: state },
    });
  }

  await updateCircuitBreaker(supabase, state);
  return state;
}

async function recordSuccess(supabase: any) {
  const state = await getCircuitBreaker(supabase);
  if (state.consecutive_blocks > 0) {
    state.consecutive_blocks = 0;
    await updateCircuitBreaker(supabase, state);
  }
}

// Adaptive rate limiter
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
    this.currentDelay = Math.max(this.baseDelay, this.currentDelay * 0.8);
  }

  onBlock() {
    this.consecutiveBlocks++;
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

// --- Ensure global attribute terms exist ---
async function ensureMaatTerms(
  wooUrl: string, wooAuth: string, maatAttrId: number,
  sizeLabels: string[], rateLimiter: AdaptiveRateLimiter
): Promise<Map<string, number>> {
  const termMap = new Map<string, number>();

  // Fetch existing terms (paginate up to 200)
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const url = `${wooUrl}/wp-json/wc/v3/products/attributes/${maatAttrId}/terms?per_page=100&page=${page}&${wooAuth}`;
    const res = await fetchWithRetry(url, { method: 'GET' }, rateLimiter);
    if (res.blocked || !res.json || !Array.isArray(res.json)) break;
    for (const t of res.json) {
      termMap.set(t.name.toLowerCase(), t.id);
    }
    hasMore = res.json.length === 100;
    page++;
    await rateLimiter.wait();
  }

  // Register missing terms
  const missing = sizeLabels.filter(s => !termMap.has(s.toLowerCase()));
  for (const label of missing) {
    const url = `${wooUrl}/wp-json/wc/v3/products/attributes/${maatAttrId}/terms?${wooAuth}`;
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: label }),
    }, rateLimiter);

    if (!res.blocked && res.json?.id) {
      termMap.set(label.toLowerCase(), res.json.id);
      console.log(`✓ Registered Maat term: "${label}" (ID ${res.json.id})`);
    } else if (res.json?.code === 'term_exists') {
      // Term exists but wasn't found — extract ID from error data
      const existingId = res.json?.data?.resource_id;
      if (existingId) termMap.set(label.toLowerCase(), existingId);
    } else {
      console.warn(`Could not register Maat term "${label}": ${res.text?.substring(0, 150)}`);
    }
    await rateLimiter.wait();
  }

  if (missing.length > 0) {
    console.log(`Maat terms: ${missing.length} registered, ${termMap.size} total`);
  }

  return termMap;
}

// --- Variation sync helper ---
async function createOrUpdateVariations(
  wooUrl: string, wooAuth: string, wooProductId: number,
  pim: any, rateLimiter: AdaptiveRateLimiter, supabase: any, tenantId: string,
  maatAttrId: number | null = null
): Promise<number> {
  const activeVariants = (pim.variants || []).filter((v: any) => v.active);
  if (activeVariants.length === 0) return 0;

  // --- PASS 1: Ensure all size terms exist in the global pa_maat attribute ---
  const sizeLabels = activeVariants.map((v: any) => v.size_label);
  let termMap = new Map<string, number>();
  if (maatAttrId) {
    termMap = await ensureMaatTerms(wooUrl, wooAuth, maatAttrId, sizeLabels, rateLimiter);
  }

  // --- PASS 2: Fetch existing WooCommerce variations ---
  const existingUrl = `${wooUrl}/wp-json/wc/v3/products/${wooProductId}/variations?per_page=100&${wooAuth}`;
  const existingResult = await fetchWithRetry(existingUrl, { method: 'GET' }, rateLimiter);
  if (existingResult.blocked || !existingResult.json) {
    console.warn(`Could not fetch existing variations for WC #${wooProductId}`);
    return 0;
  }

  const existingVariations: any[] = existingResult.json;
  const existingSkuMap = new Map<string, any>();
  for (const ev of existingVariations) {
    if (ev.sku) existingSkuMap.set(ev.sku.toLowerCase(), ev);
  }

  const prices = pim.product_prices as any;
  const regularPrice = prices?.regular?.toString() || '';
  const salePrice = prices?.list?.toString() || '';

  const toCreate: any[] = [];
  const toUpdate: any[] = [];

  // Build attribute reference using global ID
  const attrRef = maatAttrId
    ? { id: maatAttrId }
    : { name: 'pa_maat' };

  // --- PASS 3: Build create/update lists with per-variation attribute + stock ---
  for (const variant of activeVariants) {
    const variantSku = `${pim.sku}-${variant.maat_id}`;
    const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
    const existing = existingSkuMap.get(variantSku.toLowerCase());

    const varData: any = {
      sku: variantSku,
      regular_price: regularPrice,
      sale_price: salePrice,
      manage_stock: true,
      stock_quantity: stockQty,
      stock_status: stockQty > 0 ? 'instock' : 'outofstock',
      attributes: [{ ...attrRef, option: variant.size_label }],
    };

    if (variant.ean) {
      varData.meta_data = [{ key: '_ean', value: variant.ean }];
    }

    if (existing) {
      // --- PASS 3b: Attribute mapping fix ---
      // Always update if attribute is wrong (e.g. shows "Any Maat" or wrong size)
      const existingMaatAttr = (existing.attributes || []).find(
        (a: any) => a.name === 'Maat' || a.name === 'pa_maat' || (maatAttrId && a.id === maatAttrId)
      );
      const attrMismatch = !existingMaatAttr || existingMaatAttr.option !== variant.size_label;
      const stockMismatch = existing.stock_quantity !== stockQty;
      const priceMismatch = existing.regular_price !== regularPrice || (existing.sale_price || '') !== salePrice;

      if (attrMismatch || stockMismatch || priceMismatch) {
        if (attrMismatch) {
          console.log(`  Fix attr for ${variantSku}: "${existingMaatAttr?.option ?? 'ANY'}" → "${variant.size_label}"`);
        }
        toUpdate.push({ id: existing.id, ...varData });
      }
    } else {
      toCreate.push(varData);
    }
  }

  let synced = 0;

  // Batch create new variations
  if (toCreate.length > 0) {
    const batchUrl = `${wooUrl}/wp-json/wc/v3/products/${wooProductId}/variations/batch?${wooAuth}`;
    const batchResult = await fetchWithRetry(batchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ create: toCreate }),
    }, rateLimiter);

    if (batchResult.blocked) {
      await recordBlock(supabase, tenantId);
      console.warn(`Variation batch create blocked for WC #${wooProductId}`);
    } else if (batchResult.response.ok) {
      await recordSuccess(supabase);
      const createResponse = batchResult.json;
      // Log any per-variation errors from the batch response
      if (createResponse?.create) {
        const errors = createResponse.create.filter((v: any) => v.error);
        if (errors.length > 0) {
          console.warn(`${errors.length} variation create errors:`, errors.map((e: any) => `${e.sku}: ${e.error?.message}`).join('; '));
        }
        synced += createResponse.create.filter((v: any) => !v.error).length;
      } else {
        synced += toCreate.length;
      }
      console.log(`✓ Created ${synced} variations for WC #${wooProductId}`);
    } else {
      console.error(`Variation batch create failed: ${batchResult.response.status} - ${batchResult.text.substring(0, 300)}`);
    }
  }

  // Batch update existing variations (includes attribute mapping fixes)
  if (toUpdate.length > 0) {
    const batchUrl = `${wooUrl}/wp-json/wc/v3/products/${wooProductId}/variations/batch?${wooAuth}`;
    const batchResult = await fetchWithRetry(batchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update: toUpdate }),
    }, rateLimiter);

    if (batchResult.blocked) {
      await recordBlock(supabase, tenantId);
    } else if (batchResult.response.ok) {
      await recordSuccess(supabase);
      synced += toUpdate.length;
      const attrFixes = toUpdate.filter(u => {
        const ev = existingSkuMap.get(u.sku.toLowerCase());
        const ea = (ev?.attributes || []).find((a: any) => a.name === 'Maat' || a.name === 'pa_maat');
        return !ea || ea.option !== u.attributes[0]?.option;
      }).length;
      console.log(`✓ Updated ${toUpdate.length} variations for WC #${wooProductId} (${attrFixes} attr fixes)`);
    }
  }

  await rateLimiter.wait();
  return synced;
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

    // --- Circuit breaker check ---
    const cbState = await getCircuitBreaker(supabase);
    if (cbState.paused) {
      console.warn('🛑 Circuit breaker is ACTIVE — sync paused due to bot protection.');
      return new Response(JSON.stringify({
        success: false,
        paused: true,
        message: 'Sync gepauzeerd: te veel opeenvolgende bot-blocks. Hervat handmatig via het dashboard.',
        circuit_breaker: cbState,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

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

    // Fetch global "Maat" attribute ID from WooCommerce
    let maatAttrId: number | null = null;
    try {
      const attrsUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/attributes?${wooAuth}`;
      const attrsResult = await fetchWithRetry(attrsUrl, { method: 'GET' }, new AdaptiveRateLimiter(800, 5000));
      if (!attrsResult.blocked && attrsResult.json && Array.isArray(attrsResult.json)) {
        const maatAttr = attrsResult.json.find((a: any) => a.slug === 'pa_maat' || a.name === 'Maat');
        if (maatAttr) {
          maatAttrId = maatAttr.id;
          console.log(`Found global Maat attribute ID: ${maatAttrId}`);
        }
      }
    } catch (e) {
      console.warn('Could not fetch global attributes, falling back to slug-based reference');
    }

    const results: Array<{
      sku: string;
      action: 'created' | 'updated' | 'skipped' | 'error';
      changes: FieldChange[];
      message: string;
    }> = [];

    let sessionBlocks = 0;

    for (const pim of pimProducts) {
      try {
        // Search WooCommerce for this SKU
        const searchUrl = `${config.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(pim.sku)}&${wooAuth}`;
        const searchResult = await fetchWithRetry(searchUrl, { method: 'GET' }, rateLimiter);

        if (searchResult.blocked) {
          sessionBlocks++;
          const updatedCb = await recordBlock(supabase, tenantId);
          results.push({ sku: pim.sku, action: 'error', changes: [], message: 'Blocked by hosting bot protection (all retries exhausted)' });

          if (updatedCb.paused) {
            // Circuit breaker tripped — abort remaining
            results.push(...pimProducts.slice(pimProducts.indexOf(pim) + 1).map((p: any) => ({
              sku: p.sku, action: 'error' as const, changes: [],
              message: 'Skipped — circuit breaker tripped, sync paused',
            })));
            break;
          }
          continue;
        }

        // Successful request — reset persistent counter
        await recordSuccess(supabase);

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

        const isVariable = sizeOptions.length > 0;

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

        if (!isVariable) {
          desiredData.regular_price = regularPrice;
          desiredData.sale_price = salePrice;
        }

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

        const attrs: any[] = [];
        if (sizeOptions.length > 0) {
          const maatAttrDef: any = { position: 0, visible: true, variation: true, options: sizeOptions };
          if (maatAttrId) {
            maatAttrDef.id = maatAttrId;
          } else {
            maatAttrDef.name = 'Maat';
          }
          attrs.push(maatAttrDef);
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
            sessionBlocks++;
            const updatedCb = await recordBlock(supabase, tenantId);
            results.push({ sku: pim.sku, action: 'error', changes: [], message: 'Create blocked by hosting bot protection (all retries exhausted)' });
            if (updatedCb.paused) {
              results.push(...pimProducts.slice(pimProducts.indexOf(pim) + 1).map((p: any) => ({
                sku: p.sku, action: 'error' as const, changes: [],
                message: 'Skipped — circuit breaker tripped, sync paused',
              })));
              break;
            }
          } else if (!createResult.response.ok || !createResult.json) {
            results.push({ sku: pim.sku, action: 'error', changes: [], message: `Create failed: ${(createResult.text || '').substring(0, 200)}` });
          } else {
            await recordSuccess(supabase);
            const created = createResult.json;
            const allChanges: FieldChange[] = [
              { field: 'name', old_value: null, new_value: pim.title },
              { field: 'regular_price', old_value: null, new_value: regularPrice },
              ...(salePrice ? [{ field: 'sale_price', old_value: null, new_value: salePrice }] : []),
              ...(pimImages.length > 0 ? [{ field: 'images', old_value: null, new_value: `${pimImages.length} afbeeldingen` }] : []),
            ];

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

            // --- Create variations for variable products ---
            if (created.type === 'variable' && pim.variants && pim.variants.length > 0) {
              const varCreated = await createOrUpdateVariations(
                config.woocommerce_url, wooAuth, created.id, pim, rateLimiter, supabase, tenantId, maatAttrId
              );
              allChanges.push({ field: 'variations', old_value: null, new_value: `${varCreated} variaties aangemaakt` });
            }

            results.push({ sku: pim.sku, action: 'created', changes: allChanges, message: `Created WC #${created.id}` });
          }
        } else {
          // UPDATE existing product
          const woo = wooProducts[0];
          const changes: FieldChange[] = [];

          if (woo.name !== desiredData.name) changes.push({ field: 'name', old_value: woo.name, new_value: desiredData.name });
          if ((woo.description || '') !== (desiredData.description || '')) changes.push({ field: 'description', old_value: (woo.description || '').substring(0, 50), new_value: (desiredData.description || '').substring(0, 50) });
          if (!isVariable && (woo.regular_price || '') !== regularPrice) changes.push({ field: 'regular_price', old_value: woo.regular_price || '', new_value: regularPrice });
          if (!isVariable && (woo.sale_price || '') !== salePrice) changes.push({ field: 'sale_price', old_value: woo.sale_price || '', new_value: salePrice });
          if (woo.slug !== desiredData.slug && desiredData.slug) changes.push({ field: 'slug', old_value: woo.slug, new_value: desiredData.slug });

          const wooImgCount = (woo.images || []).length;
          const pimImgCount = desiredData.images?.length || 0;
          if (pimImgCount > 0 && wooImgCount !== pimImgCount) {
            changes.push({ field: 'images', old_value: `${wooImgCount} afbeeldingen`, new_value: `${pimImgCount} afbeeldingen` });
          }

          const wooAttrNames = (woo.attributes || []).map((a: any) => a.name).sort().join(',');
          const pimAttrNames = (desiredData.attributes || []).map((a: any) => a.name).sort().join(',');
          if (wooAttrNames !== pimAttrNames) {
            changes.push({ field: 'attributes', old_value: wooAttrNames || 'geen', new_value: pimAttrNames || 'geen' });
          }

          if (changes.length === 0) {
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

          const updateUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/${woo.id}?${wooAuth}`;
          const updateResult = await fetchWithRetry(updateUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(desiredData),
          }, rateLimiter);

          if (updateResult.blocked) {
            sessionBlocks++;
            const updatedCb = await recordBlock(supabase, tenantId);
            results.push({ sku: pim.sku, action: 'error', changes, message: 'Update blocked by hosting bot protection (all retries exhausted)' });
            if (updatedCb.paused) {
              results.push(...pimProducts.slice(pimProducts.indexOf(pim) + 1).map((p: any) => ({
                sku: p.sku, action: 'error' as const, changes: [],
                message: 'Skipped — circuit breaker tripped, sync paused',
              })));
              break;
            }
          } else if (!updateResult.response.ok || !updateResult.json) {
            results.push({ sku: pim.sku, action: 'error', changes, message: `Update failed: ${updateResult.response.status} - ${(updateResult.text || '').substring(0, 150)}` });
          } else {
            await recordSuccess(supabase);
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

            // --- Sync variations for variable products after update ---
            if (updated.type === 'variable' && pim.variants && pim.variants.length > 0) {
              const varSynced = await createOrUpdateVariations(
                config.woocommerce_url, wooAuth, updated.id, pim, rateLimiter, supabase, tenantId, maatAttrId
              );
              if (varSynced > 0) {
                changes.push({ field: 'variations', old_value: null, new_value: `${varSynced} variaties gesynchroniseerd` });
              }
            }

            results.push({ sku: pim.sku, action: 'updated', changes, message: `Updated ${changes.length} fields on WC #${woo.id}` });
          }
        }

        // Adaptive rate limit
        await rateLimiter.wait();

        // Abort early if session-level throttle
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
      metadata: { results: results.slice(0, 50), totals: { created, updated, skipped, errors }, session_blocks: sessionBlocks },
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
