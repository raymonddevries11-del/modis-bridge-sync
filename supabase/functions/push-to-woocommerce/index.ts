import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- Base64 image conversion for Supabase storage URLs ---
// SiteGround's firewall blocks WooCommerce from fetching Supabase storage URLs.
// We download images server-side and convert to data URLs so WooCommerce can sideload them.

const MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', JPG: 'image/jpeg',
  JPEG: 'image/jpeg', PNG: 'image/png',
};

function isSupabaseStorageUrl(url: string): boolean {
  return url.includes('supabase.co/storage') || url.includes('supabase.co/storage');
}

/**
 * Extract the storage path from a full Supabase storage URL.
 * E.g. "https://xxx.supabase.co/storage/v1/object/public/product-images/foto.JPG" → "foto.JPG"
 */
function extractStoragePath(url: string): string | null {
  const match = url.match(/\/storage\/v1\/object\/public\/product-images\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Download an image from Supabase Storage and return it as a base64 data URL.
 * Falls back to original URL on failure so the sync can continue.
 */
async function convertToDataUrl(imageUrl: string, supabase: any): Promise<string> {
  const storagePath = extractStoragePath(imageUrl);
  if (!storagePath) {
    console.warn(`Could not extract storage path from: ${imageUrl}`);
    return imageUrl; // fallback to original URL
  }

  try {
    const { data: fileData, error } = await supabase.storage
      .from('product-images')
      .download(storagePath);

    if (error || !fileData) {
      console.warn(`Failed to download ${storagePath}: ${error?.message}`);
      return imageUrl;
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Skip very large images (>5MB) to avoid memory issues
    if (bytes.length > 5 * 1024 * 1024) {
      console.warn(`Image too large for base64 conversion (${(bytes.length / 1024 / 1024).toFixed(1)}MB): ${storagePath}`);
      return imageUrl;
    }

    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const ext = storagePath.split('.').pop() || 'jpg';
    const mimeType = MIME_TYPES[ext] || 'image/jpeg';

    console.log(`✓ Converted ${storagePath} to data URL (${(bytes.length / 1024).toFixed(0)}KB)`);
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    console.warn(`Base64 conversion failed for ${storagePath}:`, err);
    return imageUrl; // fallback
  }
}

/**
 * Process an array of image URLs: convert Supabase storage URLs to base64 data URLs,
 * leave other URLs as-is.
 */
async function convertImagesToDataUrls(imageUrls: string[], supabase: any): Promise<string[]> {
  const results: string[] = [];
  for (const url of imageUrls) {
    if (isSupabaseStorageUrl(url)) {
      results.push(await convertToDataUrl(url, supabase));
    } else {
      results.push(url);
    }
  }
  return results;
}

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

interface VariationAudit {
  product_sku: string;
  woo_product_id: number;
  total_variants: number;
  created: number;
  updated: number;
  attr_fixes: number;
  stock_fixes: number;
  mis_mapped: Array<{ sku: string; expected: string; found: string }>;
}

// --- Ensure global attribute terms exist ---
// Uses cached terms from DB first, then fetches/creates via WC API only for missing ones
async function ensureAttributeTerms(
  wooUrl: string, wooAuth: string, attrId: number, attrName: string,
  values: string[], rateLimiter: AdaptiveRateLimiter,
  cachedTerms?: Array<{ id: number; name: string; slug: string }> | null,
  supabase?: any, tenantId?: string
): Promise<Map<string, number>> {
  const termMap = new Map<string, number>();

  // 1. Pre-populate from cached terms (from woo_global_attributes table)
  if (cachedTerms && cachedTerms.length > 0) {
    for (const t of cachedTerms) {
      termMap.set(t.name.toLowerCase(), t.id);
      if (t.slug) termMap.set(t.slug.toLowerCase(), t.id);
    }
  }

  // 2. Check which values still need resolution
  const unresolved = values.filter(s => !termMap.has(s.toLowerCase()));

  // 3. If all resolved from cache, skip API calls entirely
  if (unresolved.length === 0) {
    return termMap;
  }

  // 4. Fetch existing terms from WC API only if we have unresolved values
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const url = `${wooUrl}/wp-json/wc/v3/products/attributes/${attrId}/terms?per_page=100&page=${page}&${wooAuth}`;
    const res = await fetchWithRetry(url, { method: 'GET' }, rateLimiter);
    if (res.blocked || !res.json || !Array.isArray(res.json)) break;
    for (const t of res.json) {
      termMap.set(t.name.toLowerCase(), t.id);
      if (t.slug) termMap.set(t.slug.toLowerCase(), t.id);
    }
    hasMore = res.json.length === 100;
    page++;
    await rateLimiter.wait();
  }

  // 5. Register any still-missing terms
  const stillMissing = values.filter(s => !termMap.has(s.toLowerCase()));
  const newTerms: Array<{ id: number; name: string; slug: string }> = [];

  for (const label of stillMissing) {
    const url = `${wooUrl}/wp-json/wc/v3/products/attributes/${attrId}/terms?${wooAuth}`;
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: label }),
    }, rateLimiter);

    if (!res.blocked && res.json?.id) {
      termMap.set(label.toLowerCase(), res.json.id);
      newTerms.push({ id: res.json.id, name: res.json.name || label, slug: res.json.slug || '' });
      console.log(`✓ Registered ${attrName} term: "${label}" (ID ${res.json.id})`);
    } else if (res.json?.code === 'term_exists') {
      const existingId = res.json?.data?.resource_id;
      if (existingId) termMap.set(label.toLowerCase(), existingId);
    } else {
      console.warn(`Could not register ${attrName} term "${label}": ${res.text?.substring(0, 150)}`);
    }
    await rateLimiter.wait();
  }

  // 6. Update the DB cache with newly created terms
  if (newTerms.length > 0 && supabase && tenantId) {
    try {
      const { data: existing } = await supabase
        .from('woo_global_attributes')
        .select('terms')
        .eq('tenant_id', tenantId)
        .eq('woo_attr_id', attrId)
        .single();

      if (existing) {
        const currentTerms: any[] = existing.terms || [];
        const existingIds = new Set(currentTerms.map((t: any) => t.id));
        const merged = [...currentTerms, ...newTerms.filter(t => !existingIds.has(t.id))];
        await supabase
          .from('woo_global_attributes')
          .update({ terms: merged, updated_at: new Date().toISOString() })
          .eq('tenant_id', tenantId)
          .eq('woo_attr_id', attrId);
      }
    } catch (e) {
      // Non-critical — cache update failure shouldn't block the push
    }
  }

  if (stillMissing.length > 0) {
    console.log(`${attrName} terms: ${stillMissing.length} registered, ${termMap.size} total`);
  }

  return termMap;
}

// Helper: slugify attribute name to match WooCommerce pa_ prefix convention
function toWooSlug(name: string): string {
  return name.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- Variation sync helper ---
async function createOrUpdateVariations(
  wooUrl: string, wooAuth: string, wooProductId: number,
  pim: any, rateLimiter: AdaptiveRateLimiter, supabase: any, tenantId: string,
  maatAttrId: number | null = null,
  cachedTermsByAttrId: Map<number, Array<{ id: number; name: string; slug: string }>> = new Map()
): Promise<{ synced: number; audit: VariationAudit }> {
  const audit: VariationAudit = {
    product_sku: pim.sku,
    woo_product_id: wooProductId,
    total_variants: 0,
    created: 0,
    updated: 0,
    attr_fixes: 0,
    stock_fixes: 0,
    mis_mapped: [] as Array<{ sku: string; expected: string; found: string }>,
  };

  const activeVariants = (pim.variants || []).filter((v: any) => v.active);
  audit.total_variants = activeVariants.length;
  if (activeVariants.length === 0) return { synced: 0, audit };

  // --- PASS 1: Ensure all size terms exist in the global pa_maat attribute ---
  const sizeLabels = activeVariants.map((v: any) => v.size_label);
  let termMap = new Map<string, number>();
  if (maatAttrId) {
    termMap = await ensureAttributeTerms(wooUrl, wooAuth, maatAttrId, 'Maat', sizeLabels, rateLimiter, cachedTermsByAttrId.get(maatAttrId) || null, supabase, tenantId);
  }

  // --- PASS 2: Fetch existing WooCommerce variations ---
  const existingUrl = `${wooUrl}/wp-json/wc/v3/products/${wooProductId}/variations?per_page=100&${wooAuth}`;
  const existingResult = await fetchWithRetry(existingUrl, { method: 'GET' }, rateLimiter);
  if (existingResult.blocked || !existingResult.json) {
    console.warn(`Could not fetch existing variations for WC #${wooProductId}`);
    return { synced: 0, audit };
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

  // Build attribute reference using global ID — NEVER use id: 0
  const attrRef = (maatAttrId && maatAttrId > 0)
    ? { id: maatAttrId }
    : { name: 'pa_maat' };
  if (!maatAttrId || maatAttrId <= 0) {
    console.warn(`[variations] No valid global Maat ID for ${pim.sku} — using slug fallback. Risk of "all sizes" bug.`);
  }

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
      // --- PASS 3b: Attribute mapping audit + fix ---
      const existingMaatAttr = (existing.attributes || []).find(
        (a: any) => a.name === 'Maat' || a.name === 'pa_maat' || (maatAttrId && a.id === maatAttrId)
      );
      const attrMismatch = !existingMaatAttr || existingMaatAttr.option !== variant.size_label;
      const stockMismatch = existing.stock_quantity !== stockQty;
      const priceMismatch = existing.regular_price !== regularPrice || (existing.sale_price || '') !== salePrice;

      if (attrMismatch) {
        const foundOption = existingMaatAttr?.option || '(leeg/Any)';
        audit.mis_mapped.push({ sku: variantSku, expected: variant.size_label, found: foundOption });
        audit.attr_fixes++;
        console.log(`  Fix attr for ${variantSku}: "${foundOption}" → "${variant.size_label}"`);
      }
      if (stockMismatch) audit.stock_fixes++;

      if (attrMismatch || stockMismatch || priceMismatch) {
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
      if (createResponse?.create) {
        const errors = createResponse.create.filter((v: any) => v.error);
        if (errors.length > 0) {
          console.warn(`${errors.length} variation create errors:`, errors.map((e: any) => `${e.sku}: ${e.error?.message}`).join('; '));
        }
        audit.created = createResponse.create.filter((v: any) => !v.error).length;
      } else {
        audit.created = toCreate.length;
      }
      synced += audit.created;
      console.log(`✓ Created ${audit.created} variations for WC #${wooProductId}`);
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
      audit.updated = toUpdate.length;
      synced += toUpdate.length;
      console.log(`✓ Updated ${toUpdate.length} variations for WC #${wooProductId} (${audit.attr_fixes} attr fixes, ${audit.stock_fixes} stock fixes)`);
    }
  }

  // --- PASS 4: Log audit to changelog if mis-mapped variations were found ---
  if (audit.mis_mapped.length > 0) {
    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'VARIATION_ATTR_AUDIT',
      description: `${audit.mis_mapped.length} mis-mapped variaties gevonden en gecorrigeerd voor ${pim.sku} (WC #${wooProductId})`,
      metadata: {
        product_sku: pim.sku,
        woo_product_id: wooProductId,
        mis_mapped: audit.mis_mapped.slice(0, 50),
        attr_fixes: audit.attr_fixes,
        stock_fixes: audit.stock_fixes,
        total_variants: audit.total_variants,
      },
    });
  }

  await rateLimiter.wait();
  return { synced, audit };
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

    // Load cached global attributes from DB (populated by sync-woo-attributes)
    let maatAttrId: number | null = null;
    const globalAttrMap = new Map<string, { id: number; name: string; slug: string }>();
    // pimToWooMap: PIM attribute name → WC global attr info (from explicit mappings)
    const pimToWooMap = new Map<string, { id: number; name: string; slug: string }>();
    // Cached terms by WC attribute ID → array of {id, name, slug}
    const cachedTermsByAttrId = new Map<number, Array<{ id: number; name: string; slug: string }>>();

    try {
      const { data: cachedAttrs } = await supabase
        .from('woo_global_attributes')
        .select('woo_attr_id, name, slug, pim_attribute_name, terms')
        .eq('tenant_id', tenantId);

      if (cachedAttrs && cachedAttrs.length > 0) {
        for (const attr of cachedAttrs) {
          const entry = { id: attr.woo_attr_id, name: attr.name, slug: attr.slug };
          const cleanSlug = (attr.slug || '').replace(/^pa_/, '');
          globalAttrMap.set(cleanSlug.toLowerCase(), entry);
          globalAttrMap.set(attr.name.toLowerCase(), entry);

          // Cache terms for fast lookup during ensureAttributeTerms
          if (Array.isArray(attr.terms) && attr.terms.length > 0) {
            cachedTermsByAttrId.set(attr.woo_attr_id, attr.terms);
          }

          // If there's an explicit PIM mapping, register it
          if (attr.pim_attribute_name) {
            pimToWooMap.set(attr.pim_attribute_name.toLowerCase(), entry);
            pimToWooMap.set(toWooSlug(attr.pim_attribute_name), entry);
          }
        }
        const maatEntry = globalAttrMap.get('maat');
        if (maatEntry) {
          maatAttrId = maatEntry.id;
          console.log(`Found cached global Maat attribute ID: ${maatAttrId}`);
        }
        console.log(`Loaded ${cachedAttrs.length} cached WC attributes (${pimToWooMap.size / 2} PIM-mapped)`);
      } else {
        // Fallback: fetch from WC API if cache is empty
        console.warn('No cached WC attributes found, fetching from WC API...');
        const attrsUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/attributes?${wooAuth}`;
        const attrsResult = await fetchWithRetry(attrsUrl, { method: 'GET' }, new AdaptiveRateLimiter(800, 5000));
        if (!attrsResult.blocked && attrsResult.json && Array.isArray(attrsResult.json)) {
          for (const attr of attrsResult.json) {
            if (attr.id > 0) {
              const cleanSlug = (attr.slug || '').replace(/^pa_/, '');
              globalAttrMap.set(cleanSlug.toLowerCase(), { id: attr.id, name: attr.name, slug: attr.slug });
              globalAttrMap.set(attr.name.toLowerCase(), { id: attr.id, name: attr.name, slug: attr.slug });
            }
          }
          const maatEntry = globalAttrMap.get('maat');
          if (maatEntry) maatAttrId = maatEntry.id;
        }
      }

      // Fallback: auto-create pa_maat if missing
      if (!maatAttrId) {
        console.warn('Global Maat attribute not found — attempting to create it');
        const createAttrUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/attributes?${wooAuth}`;
        const createResult = await fetchWithRetry(createAttrUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Maat', slug: 'pa_maat', type: 'select', order_by: 'menu_order', has_archives: true }),
        }, new AdaptiveRateLimiter(800, 5000));

        if (!createResult.blocked && createResult.json) {
          if (createResult.json.id && createResult.json.id > 0) {
            maatAttrId = createResult.json.id;
            globalAttrMap.set('maat', { id: maatAttrId, name: 'Maat', slug: 'pa_maat' });
            console.log(`✓ Created global Maat attribute with ID: ${maatAttrId}`);
          }
        }

        if (!maatAttrId) {
          console.error('⚠️ CRITICAL: Could not resolve global pa_maat attribute ID.');
          await supabase.from('changelog').insert({
            tenant_id: tenantId,
            event_type: 'WOO_MAAT_ATTR_MISSING',
            description: 'Globaal pa_maat attribuut niet gevonden en kon niet worden aangemaakt.',
            metadata: { attempted_create: true, fallback: 'slug-based pa_maat reference' },
          });
        }
      }
    } catch (e) {
      console.warn('Could not load global attributes, falling back to slug-based reference');
    }

    // Final safety: ensure maatAttrId is never 0
    if (maatAttrId === 0) {
      console.error('⚠️ maatAttrId resolved to 0 — resetting to null to prevent WC default behaviour');
      maatAttrId = null;
    }

    const results: Array<{
      sku: string;
      action: 'created' | 'updated' | 'skipped' | 'error';
      changes: FieldChange[];
      message: string;
    }> = [];

    let sessionBlocks = 0;
    const variationAudits: VariationAudit[] = [];
    // Collect attribute mapping diagnostics across all products
    const allUnmappedAttrs = new Map<string, { count: number; slug: string; sample_values: string[] }>();
    const attrMappingStats = { total_mapped: 0, total_unmapped: 0, terms_missing: 0 };

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
        const storageBaseUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/product-images/`;
        let validImages = pimImages
          .map((img: any) => typeof img === 'string' ? img : img.url || img.src)
          .filter(Boolean)
          .map((src: string) => {
            if (src.startsWith('http://') || src.startsWith('https://')) return src;
            return `${storageBaseUrl}${src}`;
          });

        // Convert Supabase storage URLs to base64 data URLs to bypass SiteGround firewall
        if (validImages.length > 0) {
          validImages = await convertImagesToDataUrls(validImages, supabase);
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
            // Register size terms as saved global values
            await ensureAttributeTerms(config.woocommerce_url, wooAuth, maatAttrId, 'Maat', sizeOptions, rateLimiter, cachedTermsByAttrId.get(maatAttrId) || null, supabase, tenantId);
          } else {
            maatAttrDef.name = 'Maat';
          }
          attrs.push(maatAttrDef);
        }

        // --- Attribute mapping validation & logging ---
        const unmappedAttrs: Array<{ key: string; value: string; slug: string }> = [];
        const mappedAttrs: Array<{ key: string; wc_id: number; wc_name: string; value: string; term_id: number | null }> = [];

        if (pim.attributes && typeof pim.attributes === 'object') {
          const pimAttrs = pim.attributes as Record<string, any>;
          let pos = 1;
          for (const [key, val] of Object.entries(pimAttrs)) {
            if (!val) continue;
            const valStr = String(val);
            const lookupKey = toWooSlug(key);
            // Priority: 1) explicit PIM→WC mapping from DB, 2) slug match, 3) name match
            const globalAttr = pimToWooMap.get(key.toLowerCase()) || pimToWooMap.get(lookupKey) || globalAttrMap.get(lookupKey) || globalAttrMap.get(key.toLowerCase());
            if (globalAttr) {
              if (!globalAttr.id || globalAttr.id <= 0) {
                console.error(`  ⚠ Attr "${key}" matched "${globalAttr.name}" but has invalid ID: ${globalAttr.id} — skipping`);
                unmappedAttrs.push({ key, value: valStr, slug: lookupKey });
                continue;
              }
              const termResult = await ensureAttributeTerms(config.woocommerce_url, wooAuth, globalAttr.id, globalAttr.name, [valStr], rateLimiter, cachedTermsByAttrId.get(globalAttr.id) || null, supabase, tenantId);
              const termId = termResult.get(valStr.toLowerCase()) || null;
              attrs.push({ id: globalAttr.id, position: pos++, visible: true, variation: false, options: [valStr] });
              mappedAttrs.push({ key, wc_id: globalAttr.id, wc_name: globalAttr.name, value: valStr, term_id: termId });
              if (!termId) {
                console.warn(`  ⚠ Attr "${key}" → global ID ${globalAttr.id}, value="${valStr}" — term NOT resolved (may not save as filter)`);
              }
            } else {
              attrs.push({ name: key, position: pos++, visible: true, variation: false, options: [valStr] });
              unmappedAttrs.push({ key, value: valStr, slug: lookupKey });
              console.warn(`  ✗ Attr "${key}" (slug: ${lookupKey}) has no matching global WC attribute — pushed as local`);
            }
          }
        }
        if (brand) {
          const merkAttr = globalAttrMap.get('merk');
          if (merkAttr) {
            const termResult = await ensureAttributeTerms(config.woocommerce_url, wooAuth, merkAttr.id, 'Merk', [brand], rateLimiter, cachedTermsByAttrId.get(merkAttr.id) || null, supabase, tenantId);
            const termId = termResult.get(brand.toLowerCase()) || null;
            attrs.push({ id: merkAttr.id, position: attrs.length, visible: true, variation: false, options: [brand] });
            mappedAttrs.push({ key: 'Merk', wc_id: merkAttr.id, wc_name: 'Merk', value: brand, term_id: termId });
          } else {
            attrs.push({ name: 'Merk', position: attrs.length, visible: true, variation: false, options: [brand] });
            unmappedAttrs.push({ key: 'Merk', value: brand, slug: 'merk' });
          }
        }

        // Aggregate attribute mapping diagnostics
        for (const ua of unmappedAttrs) {
          const existing = allUnmappedAttrs.get(ua.key);
          if (existing) {
            existing.count++;
            if (existing.sample_values.length < 3 && !existing.sample_values.includes(ua.value)) {
              existing.sample_values.push(ua.value);
            }
          } else {
            allUnmappedAttrs.set(ua.key, { count: 1, slug: ua.slug, sample_values: [ua.value] });
          }
          attrMappingStats.total_unmapped++;
        }
        for (const ma of mappedAttrs) {
          attrMappingStats.total_mapped++;
          if (!ma.term_id) attrMappingStats.terms_missing++;
        }

        if (unmappedAttrs.length > 0) {
          console.warn(`[${pim.sku}] ${unmappedAttrs.length} unmapped attributes: ${unmappedAttrs.map(a => `"${a.key}"`).join(', ')}`);
        }
        if (mappedAttrs.length > 0) {
          const noTerm = mappedAttrs.filter(a => !a.term_id);
          console.log(`[${pim.sku}] ${mappedAttrs.length} mapped attrs (${noTerm.length} without term ID)`);
        }
        if (attrs.length > 0) desiredData.attributes = attrs;

        // Helper: merge PIM attributes with existing WooCommerce attributes (additive model)
        function mergeAttributes(pimAttrs: any[], existingWooAttrs: any[]): any[] {
          const merged = new Map<string, any>();

          // First, add all existing WooCommerce attributes (preserves manually added ones)
          for (const a of existingWooAttrs) {
            const key = a.id > 0 ? `id:${a.id}` : `name:${(a.name || '').toLowerCase()}`;
            merged.set(key, { ...a });
          }

          // Then overlay PIM attributes — PIM wins on conflict
          for (const a of pimAttrs) {
            const key = a.id ? `id:${a.id}` : `name:${(a.name || '').toLowerCase()}`;
            merged.set(key, a);
          }

          // Re-assign positions
          let pos = 0;
          const result: any[] = [];
          for (const attr of merged.values()) {
            result.push({ ...attr, position: pos++ });
          }
          return result;
        }

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
            // Check for image upload error — retry without images
            const errCode = createResult.json?.code;
            if (errCode === 'woocommerce_product_image_upload_error') {
              console.warn(`Product ${pim.sku}: image upload failed, retrying create WITHOUT images`);
              const noImgData = { ...desiredData, images: [] };
              const retryResult = await fetchWithRetry(createUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(noImgData),
              }, rateLimiter);

              if (retryResult.response.ok && retryResult.json) {
                await recordSuccess(supabase);
                const created = retryResult.json;
                console.log(`Created product ${pim.sku} (without images) with WC ID ${created.id}`);

                await supabase.from('changelog').insert({
                  tenant_id: tenantId, event_type: 'WOO_IMAGE_UPLOAD_FAILED',
                  description: `Afbeeldingen konden niet worden geüpload voor ${pim.sku} — product aangemaakt zonder afbeeldingen`,
                  metadata: { sku: pim.sku, imageCount: validImages.length, error: createResult.json?.message?.substring(0, 200) },
                });

                // Still create variations
                if (isVariable) {
                  const varResult = await createOrUpdateVariations(
                    config.woocommerce_url, wooAuth, created.id, pim, rateLimiter, supabase, tenantId, maatAttrId, cachedTermsByAttrId
                  );
                  totalVariationAudit.created += varResult.audit.created;
                }

                results.push({ sku: pim.sku, action: 'created', changes: [{ field: 'images', old_value: null, new_value: 'skipped (upload error)' }], message: `Created without images (WC #${created.id})` });
                continue;
              }
            }
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
              const varResult = await createOrUpdateVariations(
                config.woocommerce_url, wooAuth, created.id, pim, rateLimiter, supabase, tenantId, maatAttrId, cachedTermsByAttrId
              );
              allChanges.push({ field: 'variations', old_value: null, new_value: `${varResult.synced} variaties aangemaakt` });
              variationAudits.push(varResult.audit);
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

          // Merge PIM attributes with existing WooCommerce attributes (additive model)
          const existingWooAttrs = woo.attributes || [];
          const pimAttrs = desiredData.attributes || [];
          const mergedAttrs = mergeAttributes(pimAttrs, existingWooAttrs);
          desiredData.attributes = mergedAttrs;

          const wooAttrKey = existingWooAttrs.map((a: any) => `${a.id || a.name}:${(a.options || []).sort().join(',')}`).sort().join('|');
          const mergedAttrKey = mergedAttrs.map((a: any) => `${a.id || a.name}:${(a.options || []).sort().join(',')}`).sort().join('|');
          if (wooAttrKey !== mergedAttrKey) {
            changes.push({ field: 'attributes', old_value: wooAttrKey.substring(0, 100) || 'geen', new_value: mergedAttrKey.substring(0, 100) || 'geen' });
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
            // Check for image upload error — retry without images
            const errCode = updateResult.json?.code;
            if (errCode === 'woocommerce_product_image_upload_error') {
              console.warn(`Product ${pim.sku}: image upload failed on update, retrying WITHOUT images`);
              const noImgData = { ...desiredData };
              delete noImgData.images;
              const retryResult = await fetchWithRetry(updateUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(noImgData),
              }, rateLimiter);

              if (retryResult.response.ok && retryResult.json) {
                await recordSuccess(supabase);
                const updated = retryResult.json;
                console.log(`Updated product ${pim.sku} (without images) WC #${updated.id}`);

                await supabase.from('changelog').insert({
                  tenant_id: tenantId, event_type: 'WOO_IMAGE_UPLOAD_FAILED',
                  description: `Afbeeldingen konden niet worden geüpload voor ${pim.sku} — product bijgewerkt zonder afbeeldingen`,
                  metadata: { sku: pim.sku, imageCount: validImages.length, error: updateResult.json?.message?.substring(0, 200) },
                });

                await supabase.from('woo_products').upsert({
                  tenant_id: tenantId, woo_id: updated.id, product_id: pim.id,
                  sku: pim.sku, name: updated.name, slug: updated.slug,
                  permalink: updated.permalink, status: updated.status,
                  stock_status: updated.stock_status, stock_quantity: updated.stock_quantity,
                  regular_price: updated.regular_price, sale_price: updated.sale_price,
                  categories: updated.categories || [], tags: updated.tags || [],
                  images: (updated.images || []).map((img: any) => ({ id: img.id, src: img.src, alt: img.alt })),
                  type: updated.type,
                  last_fetched_at: new Date().toISOString(),
                  last_pushed_at: new Date().toISOString(),
                  last_push_changes: { action: 'updated', fields: changes, pushed_at: new Date().toISOString(), note: 'images skipped due to upload error' },
                }, { onConflict: 'tenant_id,woo_id' });

                // Still sync variations
                if (isVariable) {
                  const varResult = await createOrUpdateVariations(
                    config.woocommerce_url, wooAuth, updated.id, pim, rateLimiter, supabase, tenantId, maatAttrId, cachedTermsByAttrId
                  );
                  variationAudits.push(varResult.audit);
                }

                results.push({ sku: pim.sku, action: 'updated', changes: [...changes, { field: 'images', old_value: null, new_value: 'skipped (upload error)' }], message: `Updated without images (WC #${updated.id})` });
                continue;
              }
            }
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
              const varResult = await createOrUpdateVariations(
                config.woocommerce_url, wooAuth, updated.id, pim, rateLimiter, supabase, tenantId, maatAttrId, cachedTermsByAttrId
              );
              variationAudits.push(varResult.audit);
              if (varResult.synced > 0) {
                changes.push({ field: 'variations', old_value: null, new_value: `${varResult.synced} variaties gesynchroniseerd (${varResult.audit.attr_fixes} attr fixes)` });
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

    // Aggregate variation audit
    const totalAttrFixes = variationAudits.reduce((s, a) => s + a.attr_fixes, 0);
    const totalStockFixes = variationAudits.reduce((s, a) => s + a.stock_fixes, 0);
    const totalMisMapped = variationAudits.reduce((s, a) => s + a.mis_mapped.length, 0);
    const totalVarCreated = variationAudits.reduce((s, a) => s + a.created, 0);
    const totalVarUpdated = variationAudits.reduce((s, a) => s + a.updated, 0);

    const variationAuditSummary = {
      products_with_variations: variationAudits.length,
      variations_created: totalVarCreated,
      variations_updated: totalVarUpdated,
      attr_fixes: totalAttrFixes,
      stock_fixes: totalStockFixes,
      mis_mapped_found: totalMisMapped,
      mis_mapped_details: variationAudits.flatMap(a => a.mis_mapped).slice(0, 100),
    };

    // Attribute mapping audit
    const unmappedSummary = [...allUnmappedAttrs.entries()].map(([key, v]) => ({
      attribute: key, slug: v.slug, products_affected: v.count, sample_values: v.sample_values,
    }));
    const attrAudit = {
      ...attrMappingStats,
      unmapped_attributes: unmappedSummary,
    };

    // Log unmapped attributes as separate changelog event if any found
    if (unmappedSummary.length > 0) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_ATTR_MAPPING_GAPS',
        description: `${unmappedSummary.length} PIM-attributen zonder WC global mapping: ${unmappedSummary.map(a => `"${a.attribute}" (${a.products_affected}x)`).join(', ')}`,
        metadata: { unmapped: unmappedSummary, stats: attrMappingStats },
      });
    }

    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_PRODUCT_PUSH',
      description: `Push naar WooCommerce: ${created} aangemaakt, ${updated} bijgewerkt, ${skipped} ongewijzigd, ${errors} fouten` +
        (totalMisMapped > 0 ? ` | ${totalMisMapped} mis-mapped variaties gecorrigeerd` : '') +
        (unmappedSummary.length > 0 ? ` | ${unmappedSummary.length} attributen zonder mapping` : ''),
      metadata: {
        results: results.slice(0, 50),
        totals: { created, updated, skipped, errors },
        session_blocks: sessionBlocks,
        variation_audit: variationAuditSummary,
        attribute_audit: attrAudit,
      },
    });

    console.log(`Push complete: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`);
    if (totalMisMapped > 0) {
      console.warn(`⚠ ${totalMisMapped} mis-mapped variations detected and fixed across ${variationAudits.filter(a => a.mis_mapped.length > 0).length} products`);
    }
    if (unmappedSummary.length > 0) {
      console.warn(`⚠ ${unmappedSummary.length} PIM attributes have no global WC mapping: ${unmappedSummary.map(a => a.attribute).join(', ')}`);
    }

    return new Response(JSON.stringify({
      success: true,
      totals: { created, updated, skipped, errors },
      variation_audit: variationAuditSummary,
      attribute_audit: attrAudit,
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
