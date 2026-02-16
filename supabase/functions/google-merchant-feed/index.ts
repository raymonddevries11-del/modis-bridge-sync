// Google Merchant Feed v2 - optimized for Apparel & Accessories > Shoes
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format color for Google Merchant: max 3 values separated by "/".
 * Combines webshop + article colors for richer data.
 * E.g. webshop="Meerkleur", article="Bruin-combi" → "Bruin"
 * E.g. webshop="Zwart", article="Zwart-Combi" → "Zwart"
 */
function formatGoogleColor(color: any, attrKleur: string | null): string | null {
  const invalidColors = ['nvt', 'n.v.t.', 'n/a', 'none', 'geen', '-', '', 'meerkleur'];
  const invalidColorsStrict = ['nvt', 'n.v.t.', 'n/a', 'none', 'geen', '-', ''];

  const webshop = (color?.webshop || '').trim();
  const article = (color?.article || '').trim();
  const label = (color?.label || color?.name || '').trim();
  const attrColor = (attrKleur || '').trim();

  // Extract color names from article field, keeping compound colors together
  // E.g. "Donker Blauw" stays as one color, "Bruin-combi" → "Bruin"
  const colorPrefixes = ['donker', 'licht', 'helder', 'warm', 'off', 'dark', 'light'];
  const articleTokens = article
    ? article.split(/[\-]+/).map(s => s.trim())
        .map(s => s.replace(/\s*combi\s*/gi, '').trim()) // strip "combi" from within tokens
        .filter(s => !invalidColorsStrict.includes(s.toLowerCase()) && s.length > 1)
    : [];
  
  // Rejoin prefix+color tokens (e.g. ["Donker Blauw"] stays, not ["Donker", "Blauw"])
  const articleParts: string[] = [];
  for (const token of articleTokens) {
    const words = token.split(/\s+/);
    if (words.length >= 2 && colorPrefixes.includes(words[0].toLowerCase())) {
      // Keep compound color as single value
      articleParts.push(token);
    } else {
      articleParts.push(token);
    }
  }

  // Build candidate list: prefer specific colors
  const candidates: string[] = [];

  // Primary: webshop color if valid (not "Meerkleur")
  if (webshop && !invalidColors.includes(webshop.toLowerCase())) {
    candidates.push(webshop);
  }

  // Add article-derived parts that differ from webshop (case-insensitive dedup)
  for (const part of articleParts) {
    const normalized = part.toLowerCase().replace(/\s+/g, '');
    if (!candidates.some(c => c.toLowerCase().replace(/\s+/g, '') === normalized)) {
      candidates.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }

  // Fallback: label or attribute color
  if (candidates.length === 0) {
    const fallback = label || attrColor;
    if (fallback && !invalidColors.includes(fallback.toLowerCase())) {
      candidates.push(fallback);
    }
  }

  if (candidates.length === 0) return null;

  // Google allows max 3 colors separated by "/"
  return candidates.slice(0, 3).join('/');
}

/**
 * Generate a WooCommerce-compatible slug from a product title.
 * Mimics WordPress sanitize_title: lowercase, replace spaces/special chars with hyphens, trim dashes.
 */
function slugify(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s-]/g, '')  // remove special chars
    .replace(/[\s_]+/g, '-')        // spaces/underscores to hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '');          // trim leading/trailing hyphens
}

/**
 * Strip internal article codes/numbers from a product title.
 * Removes patterns like "46020 40572 H", "A-902 C", "222321 996", etc.
 */
function cleanTitle(title: string): string {
  if (!title) return '';
  return title
    // Remove patterns like "46020 40572 H" (multiple number groups with optional single letters)
    .replace(/\b\d{3,}[\s\-]?\d*[\s\-]?[A-Z]?\b/gi, '')
    // Remove standalone single/double letter codes like "H", "C", "LM"
    .replace(/\s+[A-Z]{1,2}\s+/g, ' ')
    // Remove leading/trailing dashes and extra spaces
    .replace(/\s*-\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build an optimized title: Brand + ProductType + Color + Maat Size
 * Strips internal article numbers for better Shopping CTR.
 */
function buildTitle(product: any, brandName: string, sizeLabel: string | null): string {
  const parts: string[] = [];

  // Brand
  if (brandName) parts.push(brandName);

  // Product type: derive from article_group description or first category
  const articleGroup = product.article_group as any;
  const productType = articleGroup?.description || articleGroup?.name || null;
  if (productType) {
    parts.push(cleanTitle(productType));
  } else {
    // Try first category name
    const cats = product.categories as any[];
    if (cats?.length) {
      const catName = typeof cats[0] === 'object' ? cats[0].name : String(cats[0]);
      if (catName) parts.push(cleanTitle(catName));
    }
  }

  // Color
  const color = product.color as any;
  if (color?.label || color?.name) {
    parts.push(color.label || color.name);
  }

  // Size - only the primary size, strip conversion notation
  if (sizeLabel) {
    const primarySize = sizeLabel.split('=')[0].trim();
    parts.push(`Maat ${primarySize}`);
  }

  // Fallback: if we only have brand, add cleaned original title
  if (parts.length <= 1) {
    parts.push(cleanTitle(product.title));
  }

  return parts.filter(p => p).join(' ');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const url = new URL(req.url);
    let tenantId = url.searchParams.get('tenantId');

    // Support POST body for tenantId (bypasses Cloudflare GET caching)
    if (!tenantId && req.method === 'POST') {
      try {
        const body = await req.json();
        tenantId = body.tenantId || null;
      } catch { /* ignore parse errors */ }
    }

    if (!tenantId) {
      return new Response('Missing tenantId', { status: 400, headers: corsHeaders });
    }

    // Load feed config
    const { data: feedConfig } = await supabase
      .from('google_feed_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!feedConfig?.enabled) {
      return new Response('Feed not enabled', { status: 404, headers: corsHeaders });
    }

    // Load category mappings
    const { data: mappings } = await supabase
      .from('google_category_mappings')
      .select('*')
      .eq('tenant_id', tenantId);

    const mappingMap = new Map<string, any>();
    for (const m of (mappings || [])) {
      mappingMap.set(m.article_group_id, m);
    }
    const fallbackCategory = feedConfig.fallback_google_category || null;

    // Pre-fetch AI content for all products (bulk lookup)
    const aiContentMap = new Map<string, { title: string; description: string; meta_description: string; features: string[] }>();
    let aiOffset = 0;
    while (true) {
      const { data: aiContent } = await supabase
        .from('product_ai_content')
        .select('product_id, ai_title, ai_long_description, ai_short_description, ai_meta_description, ai_features, status')
        .eq('tenant_id', tenantId)
        .eq('status', 'approved')
        .range(aiOffset, aiOffset + 999);
      
      if (!aiContent || aiContent.length === 0) break;
      for (const ac of aiContent) {
        // Parse ai_features: can be JSON array or string array
        let features: string[] = [];
        if (Array.isArray(ac.ai_features)) {
          features = ac.ai_features
            .map((f: any) => String(f).trim().slice(0, 150))
            .filter((f: string) => f.length > 0);
        }
        aiContentMap.set(ac.product_id, {
          title: ac.ai_title || '',
          description: ac.ai_long_description || ac.ai_short_description || '',
          meta_description: ac.ai_meta_description || '',
          features: features.slice(0, 5), // max 5 highlights to control memory
        });
      }
      if (aiContent.length < 1000) break;
      aiOffset += 1000;
    }
    console.log(`Loaded ${aiContentMap.size} approved AI content entries`);

    // Pre-fetch WooCommerce slugs AND images for accurate product URLs and image fallback
    const wooSlugMap = new Map<string, string>();
    const wooImageMap = new Map<string, string[]>();
    let wooOffset = 0;
    while (true) {
      const { data: wooProducts } = await supabase
        .from('woo_products')
        .select('product_id, slug, images')
        .eq('tenant_id', tenantId)
        .not('product_id', 'is', null)
        .range(wooOffset, wooOffset + 999);
      if (!wooProducts || wooProducts.length === 0) break;
      for (const wp of wooProducts) {
        if (wp.product_id && wp.slug) wooSlugMap.set(wp.product_id, wp.slug);
        // Extract WooCommerce-hosted image URLs
        if (wp.product_id && Array.isArray(wp.images) && wp.images.length > 0) {
          const urls = wp.images
            .map((img: any) => img?.src || '')
            .filter((src: string) => src && /^https?:\/\//i.test(src));
          if (urls.length > 0) wooImageMap.set(wp.product_id, urls);
        }
      }
      if (wooProducts.length < 1000) break;
      wooOffset += 1000;
    }
    console.log(`Loaded ${wooSlugMap.size} WooCommerce slugs, ${wooImageMap.size} WooCommerce image sets`);

    const allItems: string[] = [];
    const colorIssues: { sku: string; title: string; reason: string }[] = [];
    const imageIssues: { sku: string; title: string; reason: string; urls: string[] }[] = [];
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const { data: products, error } = await supabase
        .from('products')
        .select(`
          id, sku, title, images, color, attributes, categories, article_group,
          url_key, webshop_text, meta_title, meta_description, tax_code,
          brand_id, brands!products_brand_id_fkey(name),
          product_prices(regular, list, currency),
          variants!variants_product_id_fkey(
            id, maat_id, size_label, maat_web, ean, active, size_type,
            stock_totals(qty)
          )
        `)
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (error) throw error;
      if (!products || products.length === 0) break;

      for (const product of products) {
        const articleGroupId = (product.article_group as any)?.id;
        const mapping = articleGroupId ? mappingMap.get(articleGroupId) : null;

        // Skip products without category mapping AND without fallback
        if (!mapping && !fallbackCategory) continue;

        const effectiveCategory = mapping?.google_category || fallbackCategory;
        const effectiveCondition = mapping?.condition || 'new';
        const effectiveGender = mapping?.gender || (mapping ? null : feedConfig.fallback_gender) || null;
        const effectiveAgeGroup = mapping?.age_group || (mapping ? null : feedConfig.fallback_age_group) || null;
        const effectiveMaterial = mapping?.material || null;

        const brandName = (product.brands as any)?.name || '';
        // Handle product_prices as object (1-to-1) or array
        const priceData = product.product_prices as any;
        const price = Array.isArray(priceData) ? priceData[0] : priceData;
        const regularPrice = price?.regular || 0;
        const salePrice = price?.list && price.list < regularPrice ? price.list : null;
        const currency = price?.currency || feedConfig.currency || 'EUR';
        // Filter images: only supported formats AND prefer WooCommerce-hosted URLs
        // Supabase storage URLs are rejected by Google Merchant ("unsupported image type")
        const rawImages = (product.images as string[]) || [];
        let images = rawImages.filter((url: string) => {
          if (!url || typeof url !== 'string') return false;
          if (!/^https?:\/\//i.test(url)) return false;
          if (!/\.(jpe?g|png|gif)(\?.*)?$/i.test(url)) return false;
          if (url.includes('supabase.co/storage')) return false;
          return true;
        });

        // Fallback: use WooCommerce-hosted images from woo_products table
        if (images.length === 0) {
          const wooImages = wooImageMap.get(product.id);
          if (wooImages && wooImages.length > 0) {
            images = wooImages;
          }
        }

        // Track image issues for QA report
        if (images.length === 0 && rawImages.length > 0) {
          const reason = rawImages.every(u => u?.includes('supabase.co/storage'))
            ? 'only_supabase_storage_urls'
            : rawImages.every(u => !/\.(jpe?g|png|gif)(\?.*)?$/i.test(u || ''))
              ? 'unsupported_format'
              : 'mixed_invalid';
          imageIssues.push({ sku: product.sku, title: product.title, reason, urls: rawImages.slice(0, 3) });
        } else if (rawImages.length === 0 && !wooImageMap.has(product.id)) {
          imageIssues.push({ sku: product.sku, title: product.title, reason: 'no_images', urls: [] });
        }
        const color = (product.color as any);
        const aiData = aiContentMap.get(product.id);
        const description = aiData?.description || product.webshop_text || product.meta_description || product.title;
        const shopUrl = feedConfig.shop_url?.replace(/\/$/, '') || '';

        // 1️⃣ Skip products with no real price (price must never be 0)
        if (regularPrice <= 0) continue;

        // 2️⃣ Product URL: prefer WooCommerce slug (actual permalink), fallback to url_key, then slugified title
        const wooSlug = wooSlugMap.get(product.id);
        const cleanUrlKey = product.url_key ? product.url_key.replace(/-+$/, '').replace(/-nvt$/, '') : null;
        // Validate slug is not empty or just hyphens after cleaning
        const candidateSlug = wooSlug || (cleanUrlKey && cleanUrlKey.length > 2 ? cleanUrlKey : null) || slugify(product.title);
        
        // Skip products without a WooCommerce slug — their product page likely doesn't exist
        if (!wooSlug && !cleanUrlKey) {
          // No reliable URL available — skip to avoid "page not available" errors
          continue;
        }
        
        const productUrl = candidateSlug
          ? `${shopUrl}/product/${candidateSlug}/`
          : `${shopUrl}/shop/`;

        // Each active variant = unique product
        const variants = (product.variants as any[]) || [];
        let isFirstVariant = true;
        for (const variant of variants) {
          if (!variant.active) continue;

          const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
          const availability = stockQty > 0 ? 'in_stock' : 'out_of_stock';
          const itemId = `${product.sku}-${variant.maat_id}`;
          const sizeLabel = variant.maat_web || variant.size_label;
          const imageLink = images.length > 0 ? images[0] : '';

          // Skip if no image
          if (!imageLink) continue;

          // 3️⃣ Optimized title: approved AI title > formula title
          const aiTitle = aiData?.title;
          const formulaTitle = buildTitle(product, brandName, sizeLabel);
          let optimizedTitle: string;
          if (aiTitle) {
            const primarySize = sizeLabel ? sizeLabel.split('=')[0].trim() : null;
            optimizedTitle = primarySize && !aiTitle.toLowerCase().includes(`maat ${primarySize.toLowerCase()}`)
              ? `${aiTitle} - Maat ${primarySize}`
              : aiTitle;
          } else {
            optimizedTitle = formulaTitle;
          }

          let itemXml = `    <item>
      <g:id>${escapeXml(itemId)}</g:id>
      <g:title>${escapeXml(optimizedTitle)}</g:title>
      <g:description>${escapeXml(description)}</g:description>
      <g:link>${escapeXml(productUrl)}</g:link>
      <g:image_link>${escapeXml(imageLink as string)}</g:image_link>`;

          // Additional images (max 10)
          for (let i = 1; i < Math.min(images.length, 10); i++) {
            itemXml += `\n      <g:additional_image_link>${escapeXml(images[i] as string)}</g:additional_image_link>`;
          }

          // Availability & price
          itemXml += `
      <g:availability>${availability}</g:availability>
      <g:price>${regularPrice.toFixed(2)} ${currency}</g:price>`;

          // availability_date for out_of_stock (30 days from now as default)
          if (availability === 'out_of_stock') {
            const availDate = new Date();
            availDate.setDate(availDate.getDate() + 30);
            itemXml += `\n      <g:availability_date>${availDate.toISOString().split('T')[0]}T00:00:00+01:00</g:availability_date>`;
          }

          // 7️⃣ Sale pricing
          if (salePrice && salePrice > 0) {
            itemXml += `\n      <g:sale_price>${salePrice.toFixed(2)} ${currency}</g:sale_price>`;
          }

          // Brand & condition
          itemXml += `
      <g:brand>${escapeXml(brandName)}</g:brand>
      <g:condition>${escapeXml(effectiveCondition)}</g:condition>
      <g:google_product_category>${escapeXml(effectiveCategory)}</g:google_product_category>`;

          // 5️⃣ GTIN / Identifiers - validate: must be 8-14 digits only
          const eanRaw = (variant.ean || '').trim();
          const isValidGtin = /^\d{8,14}$/.test(eanRaw);
          if (isValidGtin) {
            itemXml += `\n      <g:gtin>${escapeXml(eanRaw)}</g:gtin>`;
          } else {
            itemXml += `\n      <g:identifier_exists>false</g:identifier_exists>`;
          }

          // Size + size system (EU) + size type from variant
          if (sizeLabel) {
            itemXml += `\n      <g:size>${escapeXml(sizeLabel)}</g:size>`;
            itemXml += `\n      <g:size_system>EU</g:size_system>`;
            itemXml += `\n      <g:size_type>${escapeXml(variant.size_type || 'regular')}</g:size_type>`;
          }

          // Color: Google format with max 3 values separated by "/"
          const attrKleur = (product.attributes as any)?.Kleur || null;
          const formattedColor = formatGoogleColor(color, attrKleur);
          const isClothingCategory = effectiveCategory && /\b(Apparel|Kleding|Shoes|Schoenen|Footwear|Clothing|Accessories)\b/i.test(effectiveCategory);
          const colorValue = formattedColor || (isClothingCategory ? 'Meerkleur' : null);
          
          // Track color issues for changelog
          if (!formattedColor) {
            colorIssues.push({
              sku: product.sku,
              title: product.title,
              reason: !color ? 'missing' : `no valid color (webshop: ${color?.webshop || '-'}, article: ${color?.article || '-'})`,
            });
          }
          
          if (colorValue) {
            itemXml += `\n      <g:color>${escapeXml(colorValue)}</g:color>`;
          }

          // Gender & age group
          if (effectiveGender) {
            itemXml += `\n      <g:gender>${escapeXml(effectiveGender)}</g:gender>`;
          }
          if (effectiveAgeGroup) {
            itemXml += `\n      <g:age_group>${escapeXml(effectiveAgeGroup)}</g:age_group>`;
          }

          // 6️⃣ Product type from article group or category
          const articleGroup = product.article_group as any;
          const productType = articleGroup?.description || articleGroup?.name || null;
          if (productType) {
            itemXml += `\n      <g:product_type>${escapeXml(productType)}</g:product_type>`;
          } else {
            const cats = product.categories as any[];
            if (cats?.length) {
              const catName = typeof cats[0] === 'object' ? cats[0].name : String(cats[0]);
              if (catName) {
                itemXml += `\n      <g:product_type>${escapeXml(catName)}</g:product_type>`;
              }
            }
          }

          // Material: from category mapping, fallback to product attributes
          const materialValue = effectiveMaterial || (product.attributes as any)?.Materiaal || null;
          if (materialValue && !['overige', 'nvt', 'n.v.t.', '-'].includes(materialValue.toLowerCase())) {
            itemXml += `\n      <g:material>${escapeXml(materialValue)}</g:material>`;
          }

          // 4️⃣ Item group ID links variants together
          itemXml += `\n      <g:item_group_id>${escapeXml(product.sku)}</g:item_group_id>`;

          // Product highlights from AI features (only on first variant to save memory)
          // Min 2, max 5, each max 150 chars
          if (isFirstVariant && aiData?.features && aiData.features.length >= 2) {
            for (const highlight of aiData.features) {
              itemXml += `\n      <g:product_highlight>${escapeXml(highlight)}</g:product_highlight>`;
            }
          }
          isFirstVariant = false;

          // Exclude from personalized advertising if description/title contains health/comfort/medical terms
          const textToCheck = `${(description || '')} ${optimizedTitle}`.toLowerCase();
          const sensitiveTerms = [
            'comfort', 'orthop', 'pijn', 'steun', 'voetbed', 'diabete', 'reuma',
            'therapeut', 'medisch', 'gezond', 'artritis', 'hallux', 'hielspoor',
            'platvoet', 'spreekvoet', 'klachten', 'verlichting', 'correctie',
            'blessure', 'herstel', 'inlegzool', 'steunzool', 'probleem',
            'sensitive', 'gevoelig', 'zwelling', 'oedeem', 'circulatie',
            'rugpijn', 'kniepijn', 'gewricht', 'spataderen', 'compressie',
            'preventie', 'behandeling', 'aandoening', 'syndroom',
          ];
          if (sensitiveTerms.some(term => textToCheck.includes(term))) {
            itemXml += `\n      <g:excluded_destination>Personalized_advertising</g:excluded_destination>`;
            itemXml += `\n      <g:excluded_destination>Display_ads</g:excluded_destination>`;
          }

          // 8️⃣ Shipping - always filled, no empty nodes
          const shippingRules = Array.isArray(feedConfig.shipping_rules) ? feedConfig.shipping_rules : [];

          if (shippingRules.length > 0) {
            for (const rule of shippingRules) {
              if (rule.country) {
                itemXml += `
      <g:shipping>
        <g:country>${escapeXml(rule.country)}</g:country>
        <g:price>${(rule.price || 0).toFixed(2)} ${currency}</g:price>
      </g:shipping>`;
              }
            }
          } else if (feedConfig.shipping_country) {
            itemXml += `
      <g:shipping>
        <g:country>${escapeXml(feedConfig.shipping_country)}</g:country>
        <g:price>${(feedConfig.shipping_price || 0).toFixed(2)} ${currency}</g:price>
      </g:shipping>`;
          }

          itemXml += `\n    </item>`;
          allItems.push(itemXml);
        }
      }

      if (products.length < batchSize) break;
      offset += batchSize;
    }

    // Log color issues to changelog (max once per 24h to avoid spam)
    if (colorIssues.length > 0) {
      const uniqueBysku = [...new Map(colorIssues.map(i => [i.sku, i])).values()];
      console.log(`Found ${uniqueBysku.length} products with color issues`);

      // Check if we already logged within the last 24 hours
      const { data: recentLog } = await supabase
        .from('changelog')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('event_type', 'FEED_COLOR_ISSUES')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);

      if (!recentLog || recentLog.length === 0) {
        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'FEED_COLOR_ISSUES',
          description: `${uniqueBysku.length} producten met ontbrekende of ongeldige kleur in Google Shopping feed`,
          metadata: {
            total_issues: uniqueBysku.length,
            samples: uniqueBysku.slice(0, 50).map(i => ({ sku: i.sku, title: i.title, reason: i.reason })),
            feed_generated_at: new Date().toISOString(),
          },
        });
    }

    // Log image issues to changelog (max once per 24h)
    if (imageIssues.length > 0) {
      const uniqueBysku = [...new Map(imageIssues.map(i => [i.sku, i])).values()];
      const byReason = {
        no_images: uniqueBysku.filter(i => i.reason === 'no_images').length,
        only_supabase_storage_urls: uniqueBysku.filter(i => i.reason === 'only_supabase_storage_urls').length,
        unsupported_format: uniqueBysku.filter(i => i.reason === 'unsupported_format').length,
        mixed_invalid: uniqueBysku.filter(i => i.reason === 'mixed_invalid').length,
      };
      console.log(`Found ${uniqueBysku.length} products with image issues:`, JSON.stringify(byReason));

      const { data: recentImageLog } = await supabase
        .from('changelog')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('event_type', 'FEED_IMAGE_ISSUES')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);

      if (!recentImageLog || recentImageLog.length === 0) {
        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'FEED_IMAGE_ISSUES',
          description: `${uniqueBysku.length} producten overgeslagen in feed wegens ontbrekende of ongeldige afbeelding`,
          metadata: {
            total_issues: uniqueBysku.length,
            by_reason: byReason,
            products: uniqueBysku.map(i => ({
              sku: i.sku,
              title: i.title,
              reason: i.reason,
              urls: i.urls,
            })),
            feed_generated_at: new Date().toISOString(),
          },
        });
      }
    }
    }

    // Build RSS 2.0 feed
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(feedConfig.feed_title || 'Google Shopping Feed')}</title>
    <link>${escapeXml(feedConfig.shop_url || '')}</link>
    <description>${escapeXml(feedConfig.feed_description || '')}</description>
${allItems.join('\n')}
  </channel>
</rss>`;

    return new Response(xml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });

  } catch (error: any) {
    console.error('Error generating Google Merchant feed:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
