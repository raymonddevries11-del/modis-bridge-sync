// Google Merchant Feed v3 - streaming XML to avoid memory limits
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

function formatGoogleColor(color: any, attrKleur: string | null): string | null {
  const invalidColors = ['nvt', 'n.v.t.', 'n/a', 'none', 'geen', '-', '', 'meerkleur'];
  const invalidColorsStrict = ['nvt', 'n.v.t.', 'n/a', 'none', 'geen', '-', ''];

  const webshop = (color?.webshop || '').trim();
  const article = (color?.article || '').trim();
  const label = (color?.label || color?.name || '').trim();
  const attrColor = (attrKleur || '').trim();

  const colorPrefixes = ['donker', 'licht', 'helder', 'warm', 'off', 'dark', 'light'];
  const articleTokens = article
    ? article.split(/[\-]+/).map(s => s.trim())
        .map(s => s.replace(/\s*combi\s*/gi, '').trim())
        .filter(s => !invalidColorsStrict.includes(s.toLowerCase()) && s.length > 1)
    : [];
  
  const articleParts: string[] = [];
  for (const token of articleTokens) {
    articleParts.push(token);
  }

  const candidates: string[] = [];
  if (webshop && !invalidColors.includes(webshop.toLowerCase())) {
    candidates.push(webshop);
  }
  for (const part of articleParts) {
    const normalized = part.toLowerCase().replace(/\s+/g, '');
    if (!candidates.some(c => c.toLowerCase().replace(/\s+/g, '') === normalized)) {
      candidates.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  if (candidates.length === 0) {
    const fallback = label || attrColor;
    if (fallback && !invalidColors.includes(fallback.toLowerCase())) {
      candidates.push(fallback);
    }
  }
  if (candidates.length === 0) return null;
  return candidates.slice(0, 3).join('/');
}

function slugifyParam(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function slugify(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function cleanTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/\b\d{3,}[\s\-]?\d*[\s\-]?[A-Z]?\b/gi, '')
    .replace(/\s+[A-Z]{1,2}\s+/g, ' ')
    .replace(/\s*-\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTitle(product: any, brandName: string, sizeLabel: string | null): string {
  const parts: string[] = [];
  if (brandName) parts.push(brandName);
  const articleGroup = product.article_group as any;
  const productType = articleGroup?.description || articleGroup?.name || null;
  if (productType) {
    parts.push(cleanTitle(productType));
  } else {
    const cats = product.categories as any[];
    if (cats?.length) {
      const catName = typeof cats[0] === 'object' ? cats[0].name : String(cats[0]);
      if (catName) parts.push(cleanTitle(catName));
    }
  }
  const color = product.color as any;
  if (color?.label || color?.name) {
    parts.push(color.label || color.name);
  }
  if (sizeLabel) {
    const primarySize = sizeLabel.split('=')[0].trim();
    parts.push(`Maat ${primarySize}`);
  }
  if (parts.length <= 1) {
    parts.push(cleanTitle(product.title));
  }
  return parts.filter(p => p).join(' ');
}

const sensitiveTerms = [
  'comfort', 'orthop', 'pijn', 'steun', 'voetbed', 'diabete', 'reuma',
  'therapeut', 'medisch', 'gezond', 'artritis', 'hallux', 'hielspoor',
  'platvoet', 'spreekvoet', 'klachten', 'verlichting', 'correctie',
  'blessure', 'herstel', 'inlegzool', 'steunzool', 'probleem',
  'sensitive', 'gevoelig', 'zwelling', 'oedeem', 'circulatie',
  'rugpijn', 'kniepijn', 'gewricht', 'spataderen', 'compressie',
  'preventie', 'behandeling', 'aandoening', 'syndroom',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const url = new URL(req.url);
    let tenantId = url.searchParams.get('tenantId');
    if (!tenantId && req.method === 'POST') {
      try { const body = await req.json(); tenantId = body.tenantId || null; } catch { /* ignore */ }
    }
    if (!tenantId) {
      return new Response('Missing tenantId', { status: 400, headers: corsHeaders });
    }

    // Load feed config
    const { data: feedConfig } = await supabase
      .from('google_feed_config').select('*').eq('tenant_id', tenantId).maybeSingle();
    if (!feedConfig?.enabled) {
      return new Response('Feed not enabled', { status: 404, headers: corsHeaders });
    }

    // Load category mappings (small set)
    const { data: mappings } = await supabase
      .from('google_category_mappings').select('*').eq('tenant_id', tenantId);
    const mappingMap = new Map<string, any>();
    for (const m of (mappings || [])) mappingMap.set(m.article_group_id, m);
    const fallbackCategory = feedConfig.fallback_google_category || null;

    // Pre-fetch AI content — only keep minimal fields
    const aiContentMap = new Map<string, { title: string; description: string; features: string[] }>();
    let aiOffset = 0;
    while (true) {
      const { data: aiContent } = await supabase
        .from('product_ai_content')
        .select('product_id, ai_title, ai_long_description, ai_short_description, ai_features, status')
        .eq('tenant_id', tenantId).eq('status', 'approved')
        .range(aiOffset, aiOffset + 999);
      if (!aiContent || aiContent.length === 0) break;
      for (const ac of aiContent) {
        let features: string[] = [];
        if (Array.isArray(ac.ai_features)) {
          features = ac.ai_features.map((f: any) => String(f).trim().slice(0, 150)).filter((f: string) => f.length > 0).slice(0, 5);
        }
        aiContentMap.set(ac.product_id, {
          title: ac.ai_title || '',
          description: ac.ai_long_description || ac.ai_short_description || '',
          features,
        });
      }
      if (aiContent.length < 1000) break;
      aiOffset += 1000;
    }
    console.log(`Loaded ${aiContentMap.size} AI content entries`);

    // Pre-fetch WooCommerce slugs & images — only keep slug + first image URL per product
    const wooSlugMap = new Map<string, string>();
    const wooImageMap = new Map<string, string>(); // only first image for fallback
    const wooProductIds = new Set<string>();
    let wooOffset = 0;
    while (true) {
      const { data: wooProducts } = await supabase
        .from('woo_products')
        .select('product_id, slug, images')
        .eq('tenant_id', tenantId).not('product_id', 'is', null)
        .range(wooOffset, wooOffset + 999);
      if (!wooProducts || wooProducts.length === 0) break;
      for (const wp of wooProducts) {
        if (wp.product_id) {
          wooProductIds.add(wp.product_id);
          if (wp.slug) wooSlugMap.set(wp.product_id, wp.slug);
        }
        if (wp.product_id && Array.isArray(wp.images) && wp.images.length > 0) {
          // Store only valid URLs, keep array for additional_image_link
          const urls = wp.images
            .map((img: any) => img?.src || '')
            .filter((src: string) => src && /^https?:\/\//i.test(src))
            .slice(0, 10); // max 10 images
          if (urls.length > 0) wooImageMap.set(wp.product_id, urls[0]);
        }
      }
      if (wooProducts.length < 1000) break;
      wooOffset += 1000;
    }
    console.log(`Loaded ${wooProductIds.size} WooCommerce products`);

    // Streaming response — generate XML in chunks to avoid memory exhaustion
    const shopUrl = feedConfig.shop_url?.replace(/\/$/, '') || '';
    const defaultCurrency = feedConfig.currency || 'EUR';
    const shippingRules = Array.isArray(feedConfig.shipping_rules) ? feedConfig.shipping_rules : [];
    const shippingCountry = feedConfig.shipping_country;
    const shippingPrice = feedConfig.shipping_price || 0;

    const encoder = new TextEncoder();
    let productOffset = 0;
    const productBatchSize = 200; // smaller batches to reduce peak memory
    let batchesProcessed = 0;
    let totalItems = 0;
    let colorIssueCount = 0;
    let imageIssueCount = 0;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // XML header
          const header = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(feedConfig.feed_title || 'Google Shopping Feed')}</title>
    <link>${escapeXml(feedConfig.shop_url || '')}</link>
    <description>${escapeXml(feedConfig.feed_description || '')}</description>
`;
          controller.enqueue(encoder.encode(header));

          // Process products in batches
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
              .range(productOffset, productOffset + productBatchSize - 1);

            if (error) throw error;
            if (!products || products.length === 0) break;

            // Build XML for this batch, then enqueue and release
            let batchXml = '';

            for (const product of products) {
              // Skip products not in WooCommerce
              if (!wooProductIds.has(product.id)) continue;

              const articleGroupId = (product.article_group as any)?.id;
              const mapping = articleGroupId ? mappingMap.get(articleGroupId) : null;
              if (!mapping && !fallbackCategory) continue;

              const effectiveCategory = mapping?.google_category || fallbackCategory;
              const effectiveCondition = mapping?.condition || 'new';
              const effectiveGender = mapping?.gender || (mapping ? null : feedConfig.fallback_gender) || null;
              const effectiveAgeGroup = mapping?.age_group || (mapping ? null : feedConfig.fallback_age_group) || null;
              const effectiveMaterial = mapping?.material || null;

              const brandName = (product.brands as any)?.name || '';
              const priceData = product.product_prices as any;
              const price = Array.isArray(priceData) ? priceData[0] : priceData;
              const regularPrice = price?.regular || 0;
              if (regularPrice <= 0) continue;
              const salePrice = price?.list && price.list < regularPrice ? price.list : null;
              const currency = price?.currency || defaultCurrency;

              // Filter images
              const rawImages = (product.images as string[]) || [];
              let images = rawImages.filter((url: string) => {
                if (!url || typeof url !== 'string') return false;
                if (!/^https?:\/\//i.test(url)) return false;
                if (!/\.(jpe?g|png|gif)(\?.*)?$/i.test(url)) return false;
                if (url.includes('supabase.co/storage')) return false;
                return true;
              });

              // Fallback to WooCommerce image
              if (images.length === 0) {
                const wooImg = wooImageMap.get(product.id);
                if (wooImg) images = [wooImg];
              }

              if (images.length === 0) {
                imageIssueCount++;
                // No image = skip product entirely (Google requires image)
                continue;
              }

              const wooSlug = wooSlugMap.get(product.id);
              const cleanUrlKey = product.url_key ? product.url_key.replace(/-+$/, '').replace(/-nvt$/, '') : null;
              const candidateSlug = wooSlug || (cleanUrlKey && cleanUrlKey.length > 2 ? cleanUrlKey : null) || slugify(product.title);
              if (!candidateSlug || candidateSlug.length <= 2) continue;
              const productUrl = `${shopUrl}/product/${candidateSlug}/`;

              const color = product.color as any;
              const aiData = aiContentMap.get(product.id);
              const description = aiData?.description || product.webshop_text || product.meta_description || product.title;

              const attrKleur = (product.attributes as any)?.Kleur || null;
              const formattedColor = formatGoogleColor(color, attrKleur);
              const isClothingCategory = effectiveCategory && /\b(Apparel|Kleding|Shoes|Schoenen|Footwear|Clothing|Accessories)\b/i.test(effectiveCategory);
              const colorValue = formattedColor || (isClothingCategory ? 'Meerkleur' : null);
              if (!formattedColor) colorIssueCount++;

              // Derive gender from product_type or categories
              const articleGroup = product.article_group as any;
              const productType = articleGroup?.description || articleGroup?.name || '';
              const cats = product.categories as any[];
              const catNames = (cats || []).map((c: any) => typeof c === 'object' ? (c.name || '') : String(c)).join(' ');
              const genderText = `${productType} ${catNames}`.toLowerCase();
              let derivedGender = effectiveGender;
              if (/\bdames\b/i.test(genderText)) {
                derivedGender = 'female';
              } else if (/\bheren\b/i.test(genderText)) {
                derivedGender = 'male';
              }

              const isVariable = product.product_type === 'variable';

              const variants = (product.variants as any[]) || [];
              let isFirstVariant = true;

              for (const variant of variants) {
                if (!variant.active) continue;
                const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
                const availability = stockQty > 0 ? 'in_stock' : 'out_of_stock';
                const itemId = `${product.sku}-${variant.maat_id}`;
                const sizeLabel = variant.maat_web || variant.size_label;
                const imageLink = images[0];

                // Build variant URL with attribute params for variable products
                let variantUrl = productUrl;
                if (isVariable) {
                  const params: string[] = [];
                  const primarySize = sizeLabel ? sizeLabel.split('=')[0].trim() : null;
                  if (primarySize) {
                    params.push(`attribute_pa_maat=${encodeURIComponent(slugifyParam(primarySize))}`);
                  }
                  if (colorValue) {
                    params.push(`attribute_pa_kleur=${encodeURIComponent(slugifyParam(colorValue.split('/')[0]))}`);
                  }
                  if (params.length > 0) {
                    variantUrl = `${productUrl}?${params.join('&')}`;
                  }
                }

                const aiTitle = aiData?.title;
                const formulaTitle = buildTitle(product, brandName, sizeLabel);
                let optimizedTitle: string;
                if (aiTitle) {
                  const pSize = sizeLabel ? sizeLabel.split('=')[0].trim() : null;
                  optimizedTitle = pSize && !aiTitle.toLowerCase().includes(`maat ${pSize.toLowerCase()}`)
                    ? `${aiTitle} - Maat ${pSize}` : aiTitle;
                } else {
                  optimizedTitle = formulaTitle;
                }

                let itemXml = `    <item>
      <g:id>${escapeXml(itemId)}</g:id>
      <g:title>${escapeXml(optimizedTitle)}</g:title>
      <g:description>${escapeXml(description)}</g:description>
      <g:link>${escapeXml(variantUrl)}</g:link>
      <g:image_link>${escapeXml(imageLink as string)}</g:image_link>`;

                for (let i = 1; i < Math.min(images.length, 10); i++) {
                  itemXml += `\n      <g:additional_image_link>${escapeXml(images[i] as string)}</g:additional_image_link>`;
                }

                itemXml += `
      <g:availability>${availability}</g:availability>
      <g:price>${regularPrice.toFixed(2)} ${currency}</g:price>`;

                if (availability === 'out_of_stock') {
                  const availDate = new Date();
                  availDate.setDate(availDate.getDate() + 30);
                  itemXml += `\n      <g:availability_date>${availDate.toISOString().split('T')[0]}T00:00:00+01:00</g:availability_date>`;
                }

                if (salePrice && salePrice > 0) {
                  itemXml += `\n      <g:sale_price>${salePrice.toFixed(2)} ${currency}</g:sale_price>`;
                }

                itemXml += `
      <g:brand>${escapeXml(brandName)}</g:brand>
      <g:condition>${escapeXml(effectiveCondition)}</g:condition>
      <g:google_product_category>${escapeXml(effectiveCategory)}</g:google_product_category>`;

                const eanRaw = (variant.ean || '').trim();
                if (/^\d{8,14}$/.test(eanRaw)) {
                  itemXml += `\n      <g:gtin>${escapeXml(eanRaw)}</g:gtin>`;
                } else {
                  itemXml += `\n      <g:identifier_exists>false</g:identifier_exists>`;
                }

                if (sizeLabel) {
                  itemXml += `\n      <g:size>${escapeXml(sizeLabel)}</g:size>`;
                  itemXml += `\n      <g:size_system>EU</g:size_system>`;
                  itemXml += `\n      <g:size_type>${escapeXml(variant.size_type || 'regular')}</g:size_type>`;
                }

                if (colorValue) {
                  itemXml += `\n      <g:color>${escapeXml(colorValue)}</g:color>`;
                }

                if (derivedGender) itemXml += `\n      <g:gender>${escapeXml(derivedGender)}</g:gender>`;
                if (effectiveAgeGroup) itemXml += `\n      <g:age_group>${escapeXml(effectiveAgeGroup)}</g:age_group>`;

                if (productType) {
                  itemXml += `\n      <g:product_type>${escapeXml(productType)}</g:product_type>`;
                } else if (cats?.length) {
                  const catName = typeof cats[0] === 'object' ? cats[0].name : String(cats[0]);
                  if (catName) itemXml += `\n      <g:product_type>${escapeXml(catName)}</g:product_type>`;
                }

                const materialValue = effectiveMaterial || (product.attributes as any)?.Materiaal || null;
                if (materialValue && !['overige', 'nvt', 'n.v.t.', '-'].includes(materialValue.toLowerCase())) {
                  itemXml += `\n      <g:material>${escapeXml(materialValue)}</g:material>`;
                }

                itemXml += `\n      <g:item_group_id>${escapeXml(product.sku)}</g:item_group_id>`;

                if (isFirstVariant && aiData?.features && aiData.features.length >= 2) {
                  for (const highlight of aiData.features) {
                    itemXml += `\n      <g:product_highlight>${escapeXml(highlight)}</g:product_highlight>`;
                  }
                }
                isFirstVariant = false;

                const textToCheck = `${(description || '')} ${optimizedTitle}`.toLowerCase();
                if (sensitiveTerms.some(term => textToCheck.includes(term))) {
                  itemXml += `\n      <g:excluded_destination>Personalized_advertising</g:excluded_destination>`;
                  itemXml += `\n      <g:excluded_destination>Display_ads</g:excluded_destination>`;
                }

                if (shippingRules.length > 0) {
                  for (const rule of shippingRules) {
                    if (rule.country) {
                      itemXml += `\n      <g:shipping>\n        <g:country>${escapeXml(rule.country)}</g:country>\n        <g:price>${(rule.price || 0).toFixed(2)} ${currency}</g:price>\n      </g:shipping>`;
                    }
                  }
                } else if (shippingCountry) {
                  itemXml += `\n      <g:shipping>\n        <g:country>${escapeXml(shippingCountry)}</g:country>\n        <g:price>${shippingPrice.toFixed(2)} ${currency}</g:price>\n      </g:shipping>`;
                }

                itemXml += `\n    </item>\n`;
                batchXml += itemXml;
                totalItems++;
              }
            }

            // Enqueue batch and release memory
            if (batchXml.length > 0) {
              controller.enqueue(encoder.encode(batchXml));
            }
            batchesProcessed++;

            if (products.length < productBatchSize) break;
            productOffset += productBatchSize;
          }

          // XML footer
          controller.enqueue(encoder.encode(`  </channel>\n</rss>`));
          controller.close();

          console.log(`Feed streamed: ${totalItems} items in ${batchesProcessed} batches, ${colorIssueCount} color issues, ${imageIssueCount} image issues`);
        } catch (err) {
          console.error('Stream error:', err);
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
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
