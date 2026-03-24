import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- WordPress Media Upload for Supabase storage images ---
// SiteGround's firewall blocks WooCommerce from fetching Supabase storage URLs.
// We download images server-side and upload them directly to WordPress Media Library,
// then use the WP media ID in the product update.

const MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', JPG: 'image/jpeg',
  JPEG: 'image/jpeg', PNG: 'image/png',
};

function isSupabaseStorageUrl(url: string): boolean {
  return url.includes('supabase.co/storage');
}

/**
 * Extract the storage path from a full Supabase storage URL.
 */
function extractStoragePath(url: string): string | null {
  const match = url.match(/\/storage\/v1\/object\/public\/product-images\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Upload an image to WordPress Media Library via REST API.
 * Returns { id, src } on success, or null on failure.
 */
async function uploadToWordPressMedia(
  imageUrl: string,
  supabase: any,
  wooBaseUrl: string,
  rateLimiter: any,
): Promise<{ id: number; src: string } | null> {
  const wpUser = Deno.env.get('WP_APP_USERNAME') || '';
  const wpPass = Deno.env.get('WP_APP_PASSWORD') || '';
  if (!wpUser || !wpPass) {
    console.warn('WP_APP_USERNAME or WP_APP_PASSWORD not configured — skipping media upload');
    return null;
  }
  const storagePath = extractStoragePath(imageUrl);
  if (!storagePath) {
    console.warn(`Could not extract storage path from: ${imageUrl}`);
    return null;
  }

  try {
    const { data: fileData, error } = await supabase.storage
      .from('product-images')
      .download(storagePath);

    if (error || !fileData) {
      console.warn(`Failed to download ${storagePath}: ${error?.message}`);
      return null;
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Skip very large images (>5MB)
    if (bytes.length > 5 * 1024 * 1024) {
      console.warn(`Image too large (${(bytes.length / 1024 / 1024).toFixed(1)}MB): ${storagePath}`);
      return null;
    }

    const filename = storagePath.split('/').pop() || 'image.jpg';
    const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeType = MIME_TYPES[ext] || MIME_TYPES[ext.toUpperCase()] || 'image/jpeg';

    // Upload to WordPress Media Library using Basic Auth
    const mediaUrl = `${wooBaseUrl}/wp-json/wp/v2/media`;
    const basicAuth = btoa(`${wpUser}:${wpPass}`);
    if (rateLimiter) await rateLimiter.wait();
    
    const uploadResp = await fetch(mediaUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': mimeType,
      },
      body: bytes,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '');
      console.warn(`WP media upload failed for ${filename} (${uploadResp.status}): ${errText.substring(0, 200)}`);
      return null;
    }

    const media = await uploadResp.json();
    console.log(`✓ Uploaded ${filename} to WP media (ID: ${media.id}, ${(bytes.length / 1024).toFixed(0)}KB)`);
    return { id: media.id, src: media.source_url || media.guid?.rendered || '' };
  } catch (err) {
    console.warn(`WP media upload failed for ${storagePath}:`, err);
    return null;
  }
}

/**
 * Ensure a brand exists in WooCommerce via the WC REST API /products/brands endpoint.
 * The taxonomy is 'product_brand' (used by Perfect WooCommerce Brands / WooCommerce Brands).
 * Returns the brand term ID, or null on failure.
 */
async function ensureWcBrandExists(
  brandName: string,
  wooBaseUrl: string,
  ck: string,
  cs: string,
  rateLimiter: any,
): Promise<number | null> {
  const base = wooBaseUrl.replace(/\/$/, '');
  const authParams = `consumer_key=${ck}&consumer_secret=${cs}`;

  try {
    // Search for existing brand via WP REST API (taxonomy: product_brand)
    const searchUrl = `${base}/wp-json/wp/v2/product_brand?search=${encodeURIComponent(brandName)}&per_page=100&${authParams}`;
    const searchResult = await fetchWithRetry(searchUrl, {}, rateLimiter);
    if (!searchResult.blocked && searchResult.json && Array.isArray(searchResult.json)) {
      const exact = searchResult.json.find((b: any) =>
        (b.name?.toLowerCase() === brandName.toLowerCase()) ||
        (b.title?.rendered?.toLowerCase() === brandName.toLowerCase())
      );
      if (exact) {
        console.log(`WC brand "${brandName}" found: ID ${exact.id}`);
        return exact.id;
      }
    }

    // Create new brand via WP REST API
    const createUrl = `${base}/wp-json/wp/v2/product_brand?${authParams}`;
    const createResult = await fetchWithRetry(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: brandName,
        slug: brandName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      }),
    }, rateLimiter);
    if (!createResult.blocked && createResult.json?.id) {
      console.log(`WC brand "${brandName}" created: ID ${createResult.json.id}`);
      return createResult.json.id;
    }

    // Fallback: try WC REST API /products/brands endpoint
    const wcSearchUrl = `${base}/wp-json/wc/v3/products/brands?search=${encodeURIComponent(brandName)}&${authParams}`;
    const wcResult = await fetchWithRetry(wcSearchUrl, {}, rateLimiter);
    if (!wcResult.blocked && wcResult.json && Array.isArray(wcResult.json)) {
      const exact = wcResult.json.find((b: any) => b.name?.toLowerCase() === brandName.toLowerCase());
      if (exact) {
        console.log(`WC brand (fallback) "${brandName}" found: ID ${exact.id}`);
        return exact.id;
      }
    }

    console.warn(`Failed to create/find WC brand "${brandName}"`);
    return null;
  } catch (err) {
    console.error(`ensureWcBrandExists error for "${brandName}":`, err);
    return null;
  }
}

/**
 * Assign a brand (product_brand taxonomy) to a WooCommerce product via the WP REST API.
 * Uses WP Application Password auth to set taxonomy terms on the product post.
 */
async function assignBrandToProduct(
  wooProductId: number,
  brandTermId: number,
  wooBaseUrl: string,
  rateLimiter: any,
  sku: string,
): Promise<void> {
  const wpUser = Deno.env.get('WP_APP_USERNAME') || '';
  const wpPass = Deno.env.get('WP_APP_PASSWORD') || '';
  if (!wpUser || !wpPass) {
    console.warn(`[${sku}] WP_APP_USERNAME/WP_APP_PASSWORD not set — cannot assign brand taxonomy`);
    return;
  }
  const auth = btoa(`${wpUser}:${wpPass}`);
  const base = wooBaseUrl.replace(/\/$/, '');

  try {
    const url = `${base}/wp-json/wp/v2/product/${wooProductId}`;
    const result = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      body: JSON.stringify({ product_brand: [brandTermId] }),
    }, rateLimiter);

    if (!result.blocked && result.response?.ok) {
      console.log(`[${sku}] ✓ Assigned brand term ${brandTermId} to WC #${wooProductId}`);
    } else {
      console.warn(`[${sku}] Failed to assign brand to WC #${wooProductId}: ${result.response?.status} ${(result.text || '').substring(0, 200)}`);
    }
  } catch (err) {
    console.error(`[${sku}] assignBrandToProduct error:`, err);
  }
}

/**
 * Process images: upload Supabase storage images to WP Media Library.
 * Returns array of { id, src, position } objects for WooCommerce product API.
 */
async function uploadImagesToWordPress(
  imageUrls: string[],
  supabase: any,
  wooBaseUrl: string,
  rateLimiter: any,
): Promise<Array<{ id: number; src: string; position: number }>> {
  const results: Array<{ id: number; src: string; position: number }> = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (isSupabaseStorageUrl(url)) {
      const media = await uploadToWordPressMedia(url, supabase, wooBaseUrl, rateLimiter);
      if (media) {
        results.push({ id: media.id, src: media.src, position: i });
      }
    } else {
      // External URL — pass through for WooCommerce to sideload
      results.push({ id: 0, src: url, position: i });
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
// Returns { termMap, failedTerms } where failedTerms lists values that could not be registered
interface TermResult {
  termMap: Map<string, number>;
  failedTerms: string[];
  registeredTerms: string[];
}

async function ensureAttributeTerms(
  wooUrl: string, wooAuth: string, attrId: number, attrName: string,
  values: string[], rateLimiter: AdaptiveRateLimiter,
  cachedTerms?: Array<{ id: number; name: string; slug: string }> | null,
  supabase?: any, tenantId?: string
): Promise<Map<string, number>>;
async function ensureAttributeTerms(
  wooUrl: string, wooAuth: string, attrId: number, attrName: string,
  values: string[], rateLimiter: AdaptiveRateLimiter,
  cachedTerms: Array<{ id: number; name: string; slug: string }> | null | undefined,
  supabase: any, tenantId: string,
  returnDetails: true
): Promise<TermResult>;
async function ensureAttributeTerms(
  wooUrl: string, wooAuth: string, attrId: number, attrName: string,
  values: string[], rateLimiter: AdaptiveRateLimiter,
  cachedTerms?: Array<{ id: number; name: string; slug: string }> | null,
  supabase?: any, tenantId?: string,
  returnDetails?: boolean
): Promise<Map<string, number> | TermResult> {
  const termMap = new Map<string, number>();
  const failedTerms: string[] = [];
  const registeredTerms: string[] = [];

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
    return returnDetails ? { termMap, failedTerms, registeredTerms } : termMap;
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
      registeredTerms.push(label);
      console.log(`✓ Registered ${attrName} term: "${label}" (ID ${res.json.id})`);
    } else if (res.json?.code === 'term_exists') {
      const existingId = res.json?.data?.resource_id;
      if (existingId) {
        termMap.set(label.toLowerCase(), existingId);
      } else {
        failedTerms.push(label);
        console.warn(`⚠ Term "${label}" exists for ${attrName} but resource_id not returned`);
      }
    } else {
      failedTerms.push(label);
      console.warn(`✗ Failed to register ${attrName} term "${label}": ${res.text?.substring(0, 150)}`);
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
    console.log(`${attrName} terms: ${registeredTerms.length} registered, ${failedTerms.length} failed, ${termMap.size} total`);
  }

  return returnDetails ? { termMap, failedTerms, registeredTerms } : termMap;
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

/**
 * After upserting a woo_products entry, clean up old duplicate entries for the same SKU.
 * This prevents stale cache rows from confusing the UI.
 */
async function cleanupDuplicateWooProducts(supabase: any, tenantId: string, sku: string, keepWooId: number) {
  try {
    const { data: dupes } = await supabase
      .from('woo_products')
      .select('id, woo_id')
      .eq('tenant_id', tenantId)
      .eq('sku', sku)
      .neq('woo_id', keepWooId);

    if (dupes && dupes.length > 0) {
      const ids = dupes.map((d: any) => d.id);
      await supabase.from('woo_products').delete().in('id', ids);
      console.log(`🧹 Cleaned up ${dupes.length} duplicate woo_products entries for SKU ${sku} (kept WC #${keepWooId}, removed WC #${dupes.map((d: any) => d.woo_id).join(', ')})`);
    }
  } catch (err) {
    console.warn(`Non-critical: failed to cleanup duplicate woo_products for ${sku}:`, err);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { tenantId, productIds, syncScope } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');
    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      throw new Error('productIds array is required');
    }
    // Scope determines which fields to push: PRICE_STOCK, CONTENT, TAXONOMY, MEDIA, VARIATIONS, or FULL (default)
    const scope = (syncScope || 'FULL').toUpperCase();
    const isScopedPush = scope !== 'FULL';
    console.log(`Push scope: ${scope} for ${productIds.length} products`);

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
        id, sku, title, webshop_text, short_description, meta_title, meta_description, focus_keyword, images, categories, attributes, url_key, color, is_promotion,
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
    const allTermMissingAttrs = new Map<string, { count: number; wc_id: number; wc_name: string; sample_values: string[] }>();
    const attrMappingStats = { total_mapped: 0, total_unmapped: 0, terms_missing: 0, terms_failed_to_register: 0, terms_newly_registered: 0 };
    let totalTermFailures = 0; // running counter across all products
    const skippedProducts: Array<{ sku: string; reason: string }> = [];
    const dedupAuditEntries: Array<{ sku: string; woo_id: number; removed: Array<{ name: string; id: number; options: string[] }> }> = [];

    for (const pim of pimProducts) {
      try {
        // Search WooCommerce for this SKU — try default status first, then all statuses
        let wooProducts: any[] = [];
        const searchUrl = `${config.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(pim.sku)}&${wooAuth}`;
        const searchResult = await fetchWithRetry(searchUrl, { method: 'GET' }, rateLimiter);

        if (searchResult.blocked) {
          sessionBlocks++;
          const updatedCb = await recordBlock(supabase, tenantId);
          results.push({ sku: pim.sku, action: 'error', changes: [], message: 'Blocked by hosting bot protection (all retries exhausted)' });

          if (updatedCb.paused) {
            results.push(...pimProducts.slice(pimProducts.indexOf(pim) + 1).map((p: any) => ({
              sku: p.sku, action: 'error' as const, changes: [],
              message: 'Skipped — circuit breaker tripped, sync paused',
            })));
            break;
          }
          continue;
        }

        await recordSuccess(supabase);

        if (!searchResult.response.ok) {
          results.push({ sku: pim.sku, action: 'error', changes: [], message: `Search failed: ${searchResult.response.status}` });
          continue;
        }
        if (!searchResult.json) {
          results.push({ sku: pim.sku, action: 'error', changes: [], message: 'WooCommerce returned non-JSON response' });
          continue;
        }

        wooProducts = searchResult.json;

        // If default search returned nothing, search across all statuses (draft, pending, private, trash)
        if (wooProducts.length === 0) {
          const allStatuses = ['draft', 'pending', 'private', 'trash'];
          for (const status of allStatuses) {
            const statusUrl = `${config.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(pim.sku)}&status=${status}&${wooAuth}`;
            const statusResult = await fetchWithRetry(statusUrl, { method: 'GET' }, rateLimiter);
            if (!statusResult.blocked && statusResult.json && Array.isArray(statusResult.json) && statusResult.json.length > 0) {
              const match = statusResult.json.find((p: any) => p.sku === pim.sku);
              if (match) {
                console.log(`[${pim.sku}] Found existing product in status "${status}": WC #${match.id}`);
                // Restore from trash if needed
                if (status === 'trash') {
                  console.log(`[${pim.sku}] Restoring from trash to draft...`);
                  const restoreUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/${match.id}?${wooAuth}`;
                  const restoreResult = await fetchWithRetry(restoreUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'draft' }),
                  }, rateLimiter);
                  if (restoreResult.response.ok) {
                    match.status = 'draft';
                    console.log(`[${pim.sku}] Restored from trash successfully`);
                  }
                }
                wooProducts = [match];
                break;
              }
            }
          }
        }
        const prices = pim.product_prices as any;
        const brand = (pim.brands as any)?.name || null;
        const regularPrice = prices?.regular?.toString() || '';
        const salePrice = prices?.list?.toString() || '';
        const sizeOptions = (pim.variants || []).filter((v: any) => v.active).map((v: any) => v.size_label);

        const isVariable = sizeOptions.length > 0;

        const aiContent = (pim.product_ai_content as any);
        const hasApprovedAi = aiContent?.status === 'approved';

        // PIM fields always win; AI content is fallback only
        const productName = pim.title?.trim() || (hasApprovedAi && aiContent.ai_title) || pim.title;
        const longDescription = pim.webshop_text?.trim() || (hasApprovedAi && aiContent.ai_long_description) || '';
        const shortDescription = pim.short_description?.trim() || (hasApprovedAi && aiContent.ai_short_description) || '';
        const metaTitle = pim.meta_title?.trim() || (hasApprovedAi && aiContent.ai_meta_title) || '';
        const metaDescription = pim.meta_description?.trim() || (hasApprovedAi && aiContent.ai_meta_description) || '';
        const focusKeyword = pim.focus_keyword?.trim() || (hasApprovedAi && aiContent.ai_keywords) || '';

        if (hasApprovedAi) {
          console.log(`Using approved AI content for ${pim.sku}: title="${productName}"`);
        }

        // --- Scope-aware payload construction ---
        const desiredData: Record<string, any> = {};

        // PRICE_STOCK scope: only prices (for simple products)
        if (scope === 'FULL' || scope === 'PRICE_STOCK') {
          if (!isVariable) {
            desiredData.regular_price = regularPrice;
            desiredData.sale_price = salePrice;
          }
        }

        // CONTENT scope: name, description, meta
        if (scope === 'FULL' || scope === 'CONTENT') {
          desiredData.name = productName;
          desiredData.description = longDescription;
          desiredData.short_description = shortDescription;
          desiredData.sku = pim.sku;
          desiredData.slug = pim.url_key || undefined;
          desiredData.meta_data = [
            ...(focusKeyword ? [{ key: 'rank_math_focus_keyword', value: focusKeyword }] : []),
            ...(metaTitle ? [{ key: 'rank_math_title', value: metaTitle }] : []),
            ...(metaDescription ? [{ key: 'rank_math_description', value: metaDescription }] : []),
          ];
        }

        // For FULL scope without CONTENT fields already set, ensure SKU is present
        if (scope === 'FULL' && !desiredData.sku) {
          desiredData.sku = pim.sku;
          desiredData.name = productName;
          desiredData.description = longDescription;
          desiredData.short_description = shortDescription;
          desiredData.slug = pim.url_key || undefined;
          desiredData.meta_data = [
            ...(focusKeyword ? [{ key: 'rank_math_focus_keyword', value: focusKeyword }] : []),
            ...(metaTitle ? [{ key: 'rank_math_title', value: metaTitle }] : []),
            ...(metaDescription ? [{ key: 'rank_math_description', value: metaDescription }] : []),
          ];
          if (!isVariable) {
            desiredData.regular_price = regularPrice;
            desiredData.sale_price = salePrice;
          }
        }

        // MEDIA scope: images
        const pimImages = Array.isArray(pim.images) ? pim.images : [];
        const storageBaseUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/product-images/`;
        let validImages = pimImages
          .map((img: any) => typeof img === 'string' ? img : img.url || img.src)
          .filter(Boolean)
          .map((src: string) => {
            if (src.startsWith('http://') || src.startsWith('https://')) return src;
            return `${storageBaseUrl}${src}`;
          });

        if ((scope === 'FULL' || scope === 'MEDIA') && validImages.length > 0) {
          const wpImages = await uploadImagesToWordPress(validImages, supabase, config.woocommerce_url, rateLimiter);
          if (wpImages.length > 0) {
            desiredData.images = wpImages.map((img) => {
              if (img.id > 0) {
                return { id: img.id, position: img.position };
              }
              return { src: img.src, position: img.position };
            });
            // Store uploaded media IDs for image_sync_status tracking
            (pim as any)._pushed_images = wpImages;
          }
        }

        // --- Resolve brand taxonomy ID (will be assigned after product create/update) ---
        let pendingBrandTermId: number | null = null;
        if (brand && scope !== 'PRICE_STOCK' && scope !== 'MEDIA' && scope !== 'VARIATIONS') {
          pendingBrandTermId = await ensureWcBrandExists(brand, config.woocommerce_url, config.woocommerce_consumer_key, config.woocommerce_consumer_secret, rateLimiter);
          if (pendingBrandTermId) {
            console.log(`[${pim.sku}] Resolved brand "${brand}" → term ID ${pendingBrandTermId}`);
          } else {
            console.warn(`[${pim.sku}] Could not resolve brand "${brand}"`);
          }
        }

        // --- Attributes, taxonomy, tags: skip for PRICE_STOCK and MEDIA scopes ---
        const attrs: any[] = [];
        const skipAttrTaxonomy = (scope === 'PRICE_STOCK' || scope === 'MEDIA');
        if (!skipAttrTaxonomy && sizeOptions.length > 0) {
          const maatAttrDef: any = { position: 0, visible: true, variation: true, options: sizeOptions };
          if (maatAttrId) {
            maatAttrDef.id = maatAttrId;
            maatAttrDef.name = 'Maat';
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

        // Track which attr IDs/names are already in attrs to prevent duplicates
        const usedAttrIds = new Set<number>(attrs.filter(a => a.id > 0).map(a => a.id));
        const usedAttrNames = new Set<string>(attrs.map(a => (a.name || '').toLowerCase()).filter(Boolean));

        if (!skipAttrTaxonomy && pim.attributes && typeof pim.attributes === 'object') {
          const pimAttrs = pim.attributes as Record<string, any>;
          let pos = 1;
          for (const [key, val] of Object.entries(pimAttrs)) {
            if (!val) continue;
            // Skip Maat (handled above) and Merk (handled below)
            if (key.toLowerCase() === 'maat' || key.toLowerCase() === 'merk') continue;
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
              // Skip if this global ID is already in attrs (prevents duplicates)
              if (usedAttrIds.has(globalAttr.id)) continue;
              const termDetails = await ensureAttributeTerms(config.woocommerce_url, wooAuth, globalAttr.id, globalAttr.name, [valStr], rateLimiter, cachedTermsByAttrId.get(globalAttr.id) || null, supabase, tenantId, true) as TermResult;
              const termId = termDetails.termMap.get(valStr.toLowerCase()) || null;
              if (termDetails.failedTerms.length > 0) {
                totalTermFailures += termDetails.failedTerms.length;
                attrMappingStats.terms_failed_to_register += termDetails.failedTerms.length;
                console.error(`  ✗ [${pim.sku}] Term registration FAILED for "${key}" wc_id:${globalAttr.id} values: ${termDetails.failedTerms.join(', ')} (running total: ${totalTermFailures})`);
              }
              if (termDetails.registeredTerms.length > 0) {
                attrMappingStats.terms_newly_registered += termDetails.registeredTerms.length;
              }
              attrs.push({ id: globalAttr.id, name: globalAttr.name, position: pos++, visible: true, variation: false, options: [valStr] });
              usedAttrIds.add(globalAttr.id);
              mappedAttrs.push({ key, wc_id: globalAttr.id, wc_name: globalAttr.name, value: valStr, term_id: termId });
              if (!termId) {
                console.warn(`  ⚠ [${pim.sku}] Attr "${key}" → wc_id:${globalAttr.id}, value="${valStr}" — term NOT resolved (total missing: ${totalTermFailures})`);
              }
            } else {
              // Skip if name already used (prevents duplicates with explicitly handled attrs)
              if (usedAttrNames.has(key.toLowerCase())) continue;
              attrs.push({ name: key, position: pos++, visible: true, variation: false, options: [valStr] });
              usedAttrNames.add(key.toLowerCase());
              unmappedAttrs.push({ key, value: valStr, slug: lookupKey });
              console.warn(`  ✗ Attr "${key}" (slug: ${lookupKey}) has no matching global WC attribute — pushed as local`);
            }
          }
        }
        if (!skipAttrTaxonomy && brand) {
          const merkAttr = globalAttrMap.get('merk');
          if (merkAttr) {
            const merkTermDetails = await ensureAttributeTerms(config.woocommerce_url, wooAuth, merkAttr.id, 'Merk', [brand], rateLimiter, cachedTermsByAttrId.get(merkAttr.id) || null, supabase, tenantId, true) as TermResult;
            const termId = merkTermDetails.termMap.get(brand.toLowerCase()) || null;
            if (merkTermDetails.failedTerms.length > 0) {
              totalTermFailures += merkTermDetails.failedTerms.length;
              attrMappingStats.terms_failed_to_register += merkTermDetails.failedTerms.length;
              console.error(`  ✗ [${pim.sku}] Merk term registration FAILED for "${brand}" (running total: ${totalTermFailures})`);
            }
            if (merkTermDetails.registeredTerms.length > 0) {
              attrMappingStats.terms_newly_registered += merkTermDetails.registeredTerms.length;
            }
            attrs.push({ id: merkAttr.id, name: 'Merk', position: attrs.length, visible: true, variation: false, options: [brand] });
            mappedAttrs.push({ key: 'Merk', wc_id: merkAttr.id, wc_name: 'Merk', value: brand, term_id: termId });
          } else {
            attrs.push({ name: 'Merk', position: attrs.length, visible: true, variation: false, options: [brand] });
            unmappedAttrs.push({ key: 'Merk', value: brand, slug: 'merk' });
          }
        }

        // --- Color-webshop attribute ---
        const pimColor = pim.color as any;
        const colorWebshop = pimColor?.webshop;
        if (!skipAttrTaxonomy && colorWebshop) {
          const colorAttr = pimToWooMap.get('color-webshop') || globalAttrMap.get('kleur') || globalAttrMap.get('color-webshop') || globalAttrMap.get('kleur-webshop');
          if (!colorAttr) console.warn(`  ⚠ Color-webshop "${colorWebshop}" — no WC global attribute found for Kleur`);
          if (colorAttr && colorAttr.id > 0 && !usedAttrIds.has(colorAttr.id)) {
            const colorTermDetails = await ensureAttributeTerms(config.woocommerce_url, wooAuth, colorAttr.id, colorAttr.name, [colorWebshop], rateLimiter, cachedTermsByAttrId.get(colorAttr.id) || null, supabase, tenantId, true) as TermResult;
            const termId = colorTermDetails.termMap.get(colorWebshop.toLowerCase()) || null;
            attrs.push({ id: colorAttr.id, name: colorAttr.name, position: attrs.length, visible: true, variation: false, options: [colorWebshop] });
            usedAttrIds.add(colorAttr.id);
            mappedAttrs.push({ key: 'Color-webshop', wc_id: colorAttr.id, wc_name: colorAttr.name, value: colorWebshop, term_id: termId });
          } else if (!usedAttrNames.has('color-webshop')) {
            attrs.push({ name: 'Color-webshop', position: attrs.length, visible: true, variation: false, options: [colorWebshop] });
            usedAttrNames.add('color-webshop');
            unmappedAttrs.push({ key: 'Color-webshop', value: colorWebshop, slug: 'color-webshop' });
          }
        }

        // --- Sale / Promotion tag (only for TAXONOMY/FULL scope) ---
        if (!skipAttrTaxonomy) {
          const existingTags = desiredData.tags || [];
          if (pim.is_promotion) {
            const hasSaleTag = existingTags.some((t: any) => t.name?.toLowerCase() === 'sale');
            if (!hasSaleTag) {
              desiredData.tags = [...existingTags, { name: 'Sale' }];
              console.log(`[${pim.sku}] Added 'Sale' tag (is_promotion=true)`);
            }
          } else {
            const filtered = existingTags.filter((t: any) => t.name?.toLowerCase() !== 'sale');
            if (filtered.length !== existingTags.length) {
              desiredData.tags = filtered;
              console.log(`[${pim.sku}] Removed 'Sale' tag (is_promotion=false)`);
            }
          }
        }


        // --- Pre-flight attribute consistency check: every attr MUST have a name ---
        const invalidAttrs = attrs.filter((a, idx) => !a.name || typeof a.name !== 'string' || a.name.trim() === '');
        if (invalidAttrs.length > 0) {
          const details = invalidAttrs.map(a => `id:${a.id ?? 'none'} pos:${a.position} opts:${(a.options || []).join(',')}`).join('; ');
          const errMsg = `[${pim.sku}] FAIL-FAST: ${invalidAttrs.length} attribute(s) missing 'name' field — ${details}`;
          console.error(`✗ ${errMsg}`);
          await supabase.from('changelog').insert({
            tenant_id: tenantId,
            event_type: 'ATTR_CONSISTENCY_FAIL',
            description: `Consistentiecheck gefaald voor ${pim.sku}: ${invalidAttrs.length} attribu(u)t(en) zonder naam`,
            metadata: { sku: pim.sku, invalid_attrs: invalidAttrs, all_attrs_count: attrs.length },
          });
          skippedProducts.push({ sku: pim.sku, reason: errMsg });
          continue; // Skip this product entirely
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
          if (!ma.term_id) {
            attrMappingStats.terms_missing++;
            const existing = allTermMissingAttrs.get(ma.key);
            if (existing) {
              existing.count++;
              if (existing.sample_values.length < 5 && !existing.sample_values.includes(ma.value)) {
                existing.sample_values.push(ma.value);
              }
            } else {
              allTermMissingAttrs.set(ma.key, { count: 1, wc_id: ma.wc_id, wc_name: ma.wc_name, sample_values: [ma.value] });
            }
          }
        }

        // --- Per-product attribute mapping audit log ---
        const warnings: string[] = [];
        for (const ma of mappedAttrs) {
          if (!ma.term_id) {
            warnings.push(`"${ma.key}" → wc_id:${ma.wc_id} value="${ma.value}" — term_id MISSING (won't appear as filter)`);
          }
        }
        for (const ua of unmappedAttrs) {
          warnings.push(`"${ua.key}" (slug:${ua.slug}) value="${ua.value}" — NO global WC attribute (pushed as local id:0)`);
        }

        // Also audit Maat
        const maatAuditEntry = maatAttrId
          ? { key: 'Maat', wc_id: maatAttrId, status: 'global', sizes: sizeOptions.length }
          : { key: 'Maat', wc_id: null, status: 'MISSING — variations may show "Any"', sizes: sizeOptions.length };
        if (!maatAttrId) warnings.push('"Maat" — NO global pa_maat attribute found (variations risk "Any Size" display)');

        if (mappedAttrs.length > 0 || unmappedAttrs.length > 0 || warnings.length > 0) {
          console.log(`[${pim.sku}] Attr audit: ${mappedAttrs.length} mapped, ${unmappedAttrs.length} unmapped, ${warnings.length} warnings`);
          for (const w of warnings) console.warn(`  ⚠ [${pim.sku}] ${w}`);

          await supabase.from('changelog').insert({
            tenant_id: tenantId,
            event_type: 'PRODUCT_ATTR_AUDIT',
            description: `Attribuut-audit ${pim.sku}: ${mappedAttrs.length} mapped (${mappedAttrs.filter(a => !a.term_id).length} zonder term), ${unmappedAttrs.length} unmapped` +
              (warnings.length > 0 ? ` | ${warnings.length} waarschuwingen` : ''),
            metadata: {
              sku: pim.sku,
              maat: maatAuditEntry,
              mapped: mappedAttrs.map(a => ({
                pim_key: a.key,
                wc_id: a.wc_id,
                wc_name: a.wc_name,
                value: a.value,
                term_id: a.term_id,
                status: a.term_id ? 'ok' : 'term_missing',
              })),
              unmapped: unmappedAttrs.map(a => ({
                pim_key: a.key,
                slug: a.slug,
                value: a.value,
                wc_id: null,
                term_id: null,
                status: 'no_global_attribute',
              })),
              warnings,
              totals: {
                mapped: mappedAttrs.length,
                unmapped: unmappedAttrs.length,
                terms_missing: mappedAttrs.filter(a => !a.term_id).length,
                warnings: warnings.length,
              },
            },
          });
        }
        if (attrs.length > 0) desiredData.attributes = attrs;

        // Helper: merge PIM attributes with existing WooCommerce attributes
        // REPLACES local (id:0) attributes when a global (id>0) version exists with the same name
        // Returns merged array + deduplication stats
        interface MergeResult {
          attrs: any[];
          removedDuplicates: Array<{ name: string; id: number; options: string[] }>;
        }
        function mergeAttributes(pimAttrs: any[], existingWooAttrs: any[]): MergeResult {
          const removedDuplicates: Array<{ name: string; id: number; options: string[] }> = [];
          // Build a set of names that PIM pushes as global (id > 0)
          const pimGlobalNames = new Set<string>();
          for (const a of pimAttrs) {
            if (a.id && a.id > 0) {
              pimGlobalNames.add((a.name || '').toLowerCase());
            }
          }

          const merged = new Map<string, any>();

          // First, add existing WooCommerce attributes — but SKIP local (id:0) ones
          // when PIM is pushing a global version with the same name
          for (const a of existingWooAttrs) {
            const nameKey = (a.name || '').toLowerCase();
            const isLocal = !a.id || a.id === 0;
            if (isLocal && pimGlobalNames.has(nameKey)) {
              // Drop the old local attribute — PIM's global version replaces it
              console.log(`  Replacing local attr "${a.name}" (id:0) with global version`);
              removedDuplicates.push({ name: a.name || nameKey, id: a.id || 0, options: a.options || [] });
              continue;
            }
            const key = a.id > 0 ? `id:${a.id}` : `name:${nameKey}`;
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
          return { attrs: result, removedDuplicates };
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
            const errCode = createResult.json?.code;

            // --- SKU already exists: look up existing product and switch to update path ---
            if (errCode === 'woocommerce_rest_product_not_created' && createResult.json?.message?.includes('zoektabel')) {
              console.warn(`[${pim.sku}] SKU already exists in WooCommerce — looking up existing product to update`);

              // Multi-strategy SKU lookup: try ?sku=, then ?search=, then local cache
              let existingWoo: any = null;

              // Strategy 1: exact SKU filter (default status)
              const lookupUrl = `${config.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(pim.sku)}&${wooAuth}`;
              const lookupResult = await fetchWithRetry(lookupUrl, { method: 'GET' }, rateLimiter);
              if (!lookupResult.blocked && lookupResult.json && Array.isArray(lookupResult.json) && lookupResult.json.length > 0) {
                existingWoo = lookupResult.json.find((p: any) => p.sku === pim.sku) || lookupResult.json[0];
                console.log(`[${pim.sku}] Found via ?sku= filter: WC #${existingWoo.id}`);
              }

              // Strategy 2: SKU filter per non-default status (draft, pending, private, trash)
              if (!existingWoo) {
                const fallbackStatuses = ['draft', 'pending', 'private', 'trash'];
                for (const status of fallbackStatuses) {
                  const statusUrl = `${config.woocommerce_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(pim.sku)}&status=${status}&${wooAuth}`;
                  const statusResult = await fetchWithRetry(statusUrl, { method: 'GET' }, rateLimiter);
                  if (!statusResult.blocked && statusResult.json && Array.isArray(statusResult.json)) {
                    const match = statusResult.json.find((p: any) => p.sku === pim.sku);
                    if (match) {
                      existingWoo = match;
                      console.log(`[${pim.sku}] Found via ?sku=&status=${status}: WC #${existingWoo.id}`);
                      // Restore from trash
                      if (status === 'trash') {
                        console.log(`[${pim.sku}] Restoring from trash to draft...`);
                        const restoreUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/${existingWoo.id}?${wooAuth}`;
                        await fetchWithRetry(restoreUrl, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ status: 'draft' }),
                        }, rateLimiter);
                      }
                      break;
                    }
                  }
                }
              }

              // Strategy 3: search parameter (catches partial matches)
              if (!existingWoo) {
                console.log(`[${pim.sku}] ?sku= across all statuses empty, trying ?search=`);
                const searchUrl2 = `${config.woocommerce_url}/wp-json/wc/v3/products?search=${encodeURIComponent(pim.sku)}&per_page=5&${wooAuth}`;
                const searchResult2 = await fetchWithRetry(searchUrl2, { method: 'GET' }, rateLimiter);
                if (!searchResult2.blocked && searchResult2.json && Array.isArray(searchResult2.json)) {
                  existingWoo = searchResult2.json.find((p: any) => p.sku === pim.sku) || null;
                  if (existingWoo) {
                    console.log(`[${pim.sku}] Found via ?search=: WC #${existingWoo.id}`);
                  }
                }
              }

              // Strategy 4: local woo_products cache
              if (!existingWoo) {
                console.log(`[${pim.sku}] All API lookups empty, checking local cache`);
                const { data: cachedEntry } = await supabase
                  .from('woo_products')
                  .select('woo_id, name, slug, status, type')
                  .eq('tenant_id', tenantId)
                  .eq('sku', pim.sku)
                  .maybeSingle();
                if (cachedEntry) {
                  existingWoo = { id: cachedEntry.woo_id, slug: cachedEntry.slug, status: cachedEntry.status, type: cachedEntry.type, attributes: [] };
                  console.log(`[${pim.sku}] Found in local cache: WC #${existingWoo.id}`);
                }
              }

              if (existingWoo) {
                console.log(`[${pim.sku}] Found existing WC product #${existingWoo.id} — updating instead of creating`);

                // Backfill woocommerce_product_id in PIM
                await supabase.from('products').update({ woocommerce_product_id: existingWoo.id }).eq('id', pim.id);

                // Cache upsert
                await supabase.from('woo_products').upsert({
                  tenant_id: tenantId, woo_id: existingWoo.id, product_id: pim.id,
                  sku: pim.sku, name: pim.title, slug: existingWoo.slug || '',
                  status: existingWoo.status || 'publish', type: existingWoo.type || 'variable',
                  last_pushed_at: new Date().toISOString(),
                }, { onConflict: 'tenant_id,woo_id' });

                // Merge attributes with existing
                if (desiredData.attributes && existingWoo.attributes) {
                  const { attrs: mergedAttrs } = mergeAttributes(desiredData.attributes, existingWoo.attributes);
                  desiredData.attributes = mergedAttrs;
                }
                delete desiredData.type;
                delete desiredData.status;

                // PUT update
                const updateUrl = `${config.woocommerce_url}/wp-json/wc/v3/products/${existingWoo.id}?${wooAuth}`;
                const updateResult = await fetchWithRetry(updateUrl, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(desiredData),
                }, rateLimiter);

                if (updateResult.response.ok && updateResult.json) {
                  await recordSuccess(supabase);
                  console.log(`[${pim.sku}] Successfully updated existing WC product #${existingWoo.id} (reattempt after SKU conflict)`);

                  // Sync variations if variable
                  if (isVariable && pim.variants && pim.variants.length > 0) {
                    const varResult = await createOrUpdateVariations(
                      config.woocommerce_url, wooAuth, existingWoo.id, pim, rateLimiter, supabase, tenantId, maatAttrId, cachedTermsByAttrId
                    );
                    variationAudits.push(varResult.audit);
                  }

                  await supabase.from('changelog').insert({
                    tenant_id: tenantId, event_type: 'WOO_SKU_CONFLICT_RESOLVED',
                    description: `SKU-conflict opgelost voor ${pim.sku}: bestaand product #${existingWoo.id} geüpdatet`,
                    metadata: { sku: pim.sku, woo_id: existingWoo.id },
                  });

                  results.push({ sku: pim.sku, action: 'updated', changes: [{ field: 'sku_conflict', old_value: 'create_failed', new_value: `updated #${existingWoo.id}` }], message: `SKU conflict resolved — updated WC #${existingWoo.id}` });
                  continue;
                } else {
                  console.error(`[${pim.sku}] Update after SKU conflict also failed: ${(updateResult.text || '').substring(0, 200)}`);
                }
              } else {
                console.error(`[${pim.sku}] SKU exists in WooCommerce but all lookup strategies failed (API ?sku=, ?search=, local cache)`);
              }
            }

            // Check for image upload error — retry without images
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

                // Cache invalidation: upsert woo_products so sync-new-products won't re-queue
                await supabase.from('woo_products').upsert({
                  tenant_id: tenantId, woo_id: created.id, product_id: pim.id,
                  sku: pim.sku, name: pim.title, slug: created.slug || '',
                  status: created.status || 'publish', type: created.type || 'variable',
                  last_pushed_at: new Date().toISOString(),
                }, { onConflict: 'tenant_id,woo_id' });

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

            // --- Assign brand taxonomy (product_brand) via WP REST API ---
            if (pendingBrandTermId) {
              await assignBrandToProduct(created.id, pendingBrandTermId, config.woocommerce_url, rateLimiter, pim.sku);
              allChanges.push({ field: 'brand', old_value: null, new_value: brand || '' });
            }

            results.push({ sku: pim.sku, action: 'created', changes: allChanges, message: `Created WC #${created.id}` });
          }
        } else {
          // UPDATE existing product
          const woo = wooProducts[0];

          // VARIATIONS or PRICE_STOCK scope on variable product: skip parent PUT, only sync variations
          if ((scope === 'VARIATIONS' || (scope === 'PRICE_STOCK' && isVariable)) && woo.type === 'variable' && pim.variants && pim.variants.length > 0) {
            const varResult = await createOrUpdateVariations(
              config.woocommerce_url, wooAuth, woo.id, pim, rateLimiter, supabase, tenantId, maatAttrId, cachedTermsByAttrId
            );
            variationAudits.push(varResult.audit);
            results.push({
              sku: pim.sku, action: 'updated',
              changes: [{ field: 'variations', old_value: null, new_value: `${varResult.synced} variaties gesynchroniseerd (scope: ${scope})` }],
              message: `Variations-only update on WC #${woo.id} (${varResult.synced} synced)`,
            });
            await rateLimiter.wait();
            continue;
          }

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
          const mergeResult = mergeAttributes(pimAttrs, existingWooAttrs);
          desiredData.attributes = mergeResult.attrs;

          // Track dedup stats for post-push audit
          if (mergeResult.removedDuplicates.length > 0) {
            dedupAuditEntries.push({
              sku: pim.sku,
              woo_id: woo.id,
              removed: mergeResult.removedDuplicates,
            });
          }

          const wooAttrKey = existingWooAttrs.map((a: any) => `${a.id || a.name}:${(a.options || []).sort().join(',')}`).sort().join('|');
          const mergedAttrKey = mergeResult.attrs.map((a: any) => `${a.id || a.name}:${(a.options || []).sort().join(',')}`).sort().join('|');
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

            // --- Assign brand taxonomy (product_brand) via WP REST API ---
            if (pendingBrandTermId) {
              await assignBrandToProduct(woo.id, pendingBrandTermId, config.woocommerce_url, rateLimiter, pim.sku);
              changes.push({ field: 'brand', old_value: null, new_value: brand || '' });
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

    // --- Post-push: update product_sync_status and clear dirty flags per scope ---
    const successfulProducts = results.filter(r => r.action === 'created' || r.action === 'updated');
    if (successfulProducts.length > 0) {
      const now = new Date().toISOString();
      const scopeTimestampCol = {
        'PRICE_STOCK': 'last_synced_at_price_stock',
        'CONTENT': 'last_synced_at_content',
        'TAXONOMY': 'last_synced_at_taxonomy',
        'MEDIA': 'last_synced_at_media',
        'VARIATIONS': 'last_synced_at_variations',
      } as Record<string, string>;

      const dirtyFlagCol = {
        'PRICE_STOCK': 'dirty_price_stock',
        'CONTENT': 'dirty_content',
        'TAXONOMY': 'dirty_taxonomy',
        'MEDIA': 'dirty_media',
        'VARIATIONS': 'dirty_variations',
      } as Record<string, string>;

      for (const r of successfulProducts) {
        const pim = pimProducts.find((p: any) => p.sku === r.sku);
        if (!pim) continue;

        try {
          // Update product_sync_status
          const syncStatusUpdate: Record<string, any> = {
            last_synced_at: now,
            sync_count: 1, // will be incremented via upsert
          };
          if (scope === 'FULL') {
            // Update all scope timestamps
            for (const col of Object.values(scopeTimestampCol)) {
              syncStatusUpdate[col] = now;
            }
          } else if (scopeTimestampCol[scope]) {
            syncStatusUpdate[scopeTimestampCol[scope]] = now;
          }

          await supabase.from('product_sync_status').upsert({
            product_id: pim.id,
            tenant_id: tenantId,
            ...syncStatusUpdate,
          }, { onConflict: 'product_id' });

          // Clear dirty flags on products table
          const productUpdate: Record<string, any> = {};
          if (scope === 'FULL') {
            for (const col of Object.values(dirtyFlagCol)) {
              productUpdate[col] = false;
            }
          } else if (dirtyFlagCol[scope]) {
            productUpdate[dirtyFlagCol[scope]] = false;
          }

          if (Object.keys(productUpdate).length > 0) {
            await supabase.from('products').update(productUpdate).eq('id', pim.id);
          }

          // Update products.woocommerce_product_id for creates
          if (r.action === 'created') {
            const wooIdMatch = r.message.match(/WC #(\d+)/);
            if (wooIdMatch) {
              const wooId = parseInt(wooIdMatch[1]);
              await supabase.from('products').update({
                woocommerce_product_id: wooId,
              }).eq('id', pim.id);
            }
          }

          // Cleanup duplicate woo_products entries for this SKU
          const wooIdMatch = r.message.match(/WC #(\d+)/);
          if (wooIdMatch) {
            await cleanupDuplicateWooProducts(supabase, tenantId, pim.sku, parseInt(wooIdMatch[1]));
          }
        } catch (syncStatusErr) {
          console.warn(`Non-critical: failed to update sync status for ${pim.sku}:`, syncStatusErr);
        }
      }
      console.log(`✓ Updated sync status for ${successfulProducts.length} products (scope: ${scope})`);
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
      attribute: key, slug: v.slug, wc_id: null, products_affected: v.count, sample_values: v.sample_values, issue: 'no_global_attribute',
    }));
    const termMissingSummary = [...allTermMissingAttrs.entries()].map(([key, v]) => ({
      attribute: key, wc_id: v.wc_id, wc_name: v.wc_name, products_affected: v.count, sample_values: v.sample_values, issue: 'term_not_registered',
    }));
    const attrAudit = {
      ...attrMappingStats,
      unmapped_attributes: unmappedSummary,
      terms_missing_attributes: termMissingSummary,
    };

    // Log unmapped/term-missing attributes as separate changelog event for quick diagnostic
    if (unmappedSummary.length > 0 || termMissingSummary.length > 0) {
      const gapParts: string[] = [];
      if (unmappedSummary.length > 0) {
        gapParts.push(`${unmappedSummary.length} zonder global WC mapping: ${unmappedSummary.map(a => `"${a.attribute}" (${a.products_affected}x)`).join(', ')}`);
      }
      if (termMissingSummary.length > 0) {
        gapParts.push(`${termMissingSummary.length} met WC ID maar zonder term: ${termMissingSummary.map(a => `"${a.attribute}" wc_id:${a.wc_id} (${a.products_affected}x, values: ${a.sample_values.join('/')})`).join(', ')}`);
      }
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'WOO_ATTR_MAPPING_GAPS',
        description: gapParts.join(' | '),
        metadata: {
          unmapped: unmappedSummary,
          terms_missing: termMissingSummary,
          stats: attrMappingStats,
          products_pushed: pimProducts.length,
        },
      });
    }

    await supabase.from('changelog').insert({
      tenant_id: tenantId,
      event_type: 'WOO_PRODUCT_PUSH',
      description: `Push naar WooCommerce: ${created} aangemaakt, ${updated} bijgewerkt, ${skipped} ongewijzigd, ${errors} fouten` +
        (totalMisMapped > 0 ? ` | ${totalMisMapped} mis-mapped variaties gecorrigeerd` : '') +
        (unmappedSummary.length > 0 ? ` | ${unmappedSummary.length} attributen zonder mapping` : '') +
        (attrMappingStats.terms_failed_to_register > 0 ? ` | ${attrMappingStats.terms_failed_to_register} termen niet geregistreerd` : '') +
        (attrMappingStats.terms_newly_registered > 0 ? ` | ${attrMappingStats.terms_newly_registered} nieuwe termen aangemaakt` : ''),
      metadata: {
        results: results.slice(0, 50),
        totals: { created, updated, skipped, errors },
        session_blocks: sessionBlocks,
        variation_audit: variationAuditSummary,
        attribute_audit: attrAudit,
        term_summary: {
          total_terms_missing: attrMappingStats.terms_missing,
          total_terms_failed_to_register: attrMappingStats.terms_failed_to_register,
          total_terms_newly_registered: attrMappingStats.terms_newly_registered,
        },
      },
    });

    // Post-push deduplication audit log
    if (dedupAuditEntries.length > 0) {
      const totalRemoved = dedupAuditEntries.reduce((sum, e) => sum + e.removed.length, 0);
      console.log(`🧹 Dedup audit: ${totalRemoved} local duplicate(s) removed across ${dedupAuditEntries.length} product(s)`);
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'ATTR_DEDUP_AUDIT',
        description: `Deduplicatie: ${totalRemoved} lokale duplicaten verwijderd bij ${dedupAuditEntries.length} product(en)`,
        metadata: {
          products_affected: dedupAuditEntries.length,
          total_duplicates_removed: totalRemoved,
          samples: dedupAuditEntries.slice(0, 20).map(e => ({
            sku: e.sku,
            woo_id: e.woo_id,
            removed_attrs: e.removed.map(r => ({ name: r.name, options: r.options.slice(0, 3) })),
          })),
        },
      });
    }

    // --- Image sync status tracking ---
    try {
      const imageStatusUpserts: any[] = [];
      for (const r of results) {
        const pim = pimProducts.find((p: any) => p.sku === r.sku);
        if (!pim) continue;
        const pimImages = Array.isArray(pim.images) ? pim.images : [];
        if (pimImages.length === 0) continue;

        const hasImageChange = r.changes.some((c: FieldChange) => c.field === 'images');
        const imageUploadFailed = r.changes.some((c: FieldChange) => c.field === 'images' && c.new_value?.includes('skipped'));
        
        // Get WP media IDs from the WooCommerce response if available
        const wooMediaIds: number[] = [];
        if (r.action === 'created' || r.action === 'updated') {
          // desiredData.images contains the uploaded media IDs
          const desiredImages = Array.isArray(pim._pushed_images) ? pim._pushed_images : [];
          for (const img of desiredImages) {
            if (img.id > 0) wooMediaIds.push(img.id);
          }
        }

        imageStatusUpserts.push({
          product_id: pim.id,
          tenant_id: tenantId,
          status: imageUploadFailed ? 'failed' : (r.action === 'error' ? 'failed' : 'uploaded'),
          image_count: pimImages.length,
          uploaded_count: imageUploadFailed ? 0 : pimImages.length,
          failed_count: imageUploadFailed ? pimImages.length : 0,
          woo_media_ids: wooMediaIds,
          error_message: imageUploadFailed ? 'Image upload failed — pushed without images' : (r.action === 'error' ? r.message : null),
          push_attempted_at: new Date().toISOString(),
          push_confirmed_at: (!imageUploadFailed && r.action !== 'error') ? new Date().toISOString() : null,
        });
      }

      if (imageStatusUpserts.length > 0) {
        // Batch upsert in groups of 100
        for (let i = 0; i < imageStatusUpserts.length; i += 100) {
          await supabase.from('image_sync_status').upsert(
            imageStatusUpserts.slice(i, i + 100),
            { onConflict: 'product_id' }
          );
        }
        console.log(`📸 Image sync status: ${imageStatusUpserts.filter(s => s.status === 'uploaded').length} uploaded, ${imageStatusUpserts.filter(s => s.status === 'failed').length} failed`);
      }
    } catch (imgStatusErr) {
      console.warn('Non-critical: failed to update image_sync_status:', imgStatusErr);
    }

    console.log(`Push complete: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`);
    if (skippedProducts.length > 0) {
      console.warn(`⚠ ${skippedProducts.length} product(s) SKIPPED due to attribute consistency failures:`);
      for (const sp of skippedProducts) console.warn(`  → ${sp.sku}: ${sp.reason}`);
    }
    console.log(`Term summary: ${attrMappingStats.terms_missing} missing, ${attrMappingStats.terms_failed_to_register} failed to register, ${attrMappingStats.terms_newly_registered} newly registered`);
    if (totalMisMapped > 0) {
      console.warn(`⚠ ${totalMisMapped} mis-mapped variations detected and fixed across ${variationAudits.filter(a => a.mis_mapped.length > 0).length} products`);
    }
    if (unmappedSummary.length > 0) {
      console.warn(`⚠ ${unmappedSummary.length} PIM attributes have no global WC mapping: ${unmappedSummary.map(a => a.attribute).join(', ')}`);
    }
    if (attrMappingStats.terms_failed_to_register > 0) {
      console.error(`✗ ${attrMappingStats.terms_failed_to_register} terms could NOT be registered in WooCommerce — these attributes won't work as filters`);
    }

    return new Response(JSON.stringify({
      success: true,
      totals: { created, updated, skipped, errors },
      consistency_skipped: skippedProducts,
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
