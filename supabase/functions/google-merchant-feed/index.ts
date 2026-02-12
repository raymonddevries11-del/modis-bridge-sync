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

    // Pre-fetch AI titles for all products (bulk lookup)
    const aiTitleMap = new Map<string, string>();
    let aiOffset = 0;
    while (true) {
      const { data: aiContent } = await supabase
        .from('product_ai_content')
        .select('product_id, ai_title, status')
        .eq('tenant_id', tenantId)
        .not('ai_title', 'is', null)
        .in('status', ['approved', 'generated'])
        .range(aiOffset, aiOffset + 999);
      
      if (!aiContent || aiContent.length === 0) break;
      for (const ac of aiContent) {
        if (ac.ai_title) aiTitleMap.set(ac.product_id, ac.ai_title);
      }
      if (aiContent.length < 1000) break;
      aiOffset += 1000;
    }
    console.log(`Loaded ${aiTitleMap.size} AI titles`);

    const allItems: string[] = [];
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
            id, maat_id, size_label, maat_web, ean, active,
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
        const images = (product.images as string[]) || [];
        const color = (product.color as any);
        const description = product.webshop_text || product.meta_description || product.title;
        const shopUrl = feedConfig.shop_url?.replace(/\/$/, '') || '';

        // 1️⃣ Skip products with no real price (price must never be 0)
        if (regularPrice <= 0) continue;

        // 2️⃣ Product URL: prefer url_key from DB, fallback to slugified title
        const productSlug = product.url_key || slugify(product.title);
        const productUrl = productSlug
          ? `${shopUrl}/product/${productSlug}/`
          : `${shopUrl}/shop/`;

        // Each active variant = unique product
        const variants = (product.variants as any[]) || [];
        for (const variant of variants) {
          if (!variant.active) continue;

          const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
          const availability = stockQty > 0 ? 'in_stock' : 'out_of_stock';
          const itemId = `${product.sku}-${variant.maat_id}`;
          const sizeLabel = variant.maat_web || variant.size_label;
          const imageLink = images.length > 0 ? images[0] : '';

          // Skip if no image
          if (!imageLink) continue;

          // 3️⃣ Optimized title: AI title (if available) > formula title
          const aiTitle = aiTitleMap.get(product.id);
          const formulaTitle = buildTitle(product, brandName, sizeLabel);
          // For AI titles, append size if not already included
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

          // 5️⃣ GTIN / Identifiers - no empty GTIN fields
          if (variant.ean && variant.ean.trim() !== '') {
            itemXml += `\n      <g:gtin>${escapeXml(variant.ean.trim())}</g:gtin>`;
          } else {
            itemXml += `\n      <g:identifier_exists>false</g:identifier_exists>`;
          }

          // Size
          if (sizeLabel) {
            itemXml += `\n      <g:size>${escapeXml(sizeLabel)}</g:size>`;
          }

          // Color
          if (color?.label || color?.name) {
            itemXml += `\n      <g:color>${escapeXml(color.label || color.name)}</g:color>`;
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

          // Material
          if (effectiveMaterial) {
            itemXml += `\n      <g:material>${escapeXml(effectiveMaterial)}</g:material>`;
          }

          // 4️⃣ Item group ID links variants together
          itemXml += `\n      <g:item_group_id>${escapeXml(product.sku)}</g:item_group_id>`;

          // Exclude from personalized advertising if description contains health/comfort terms
          const descLower = (description || '').toLowerCase();
          const sensitiveTerms = ['comfort', 'orthop', 'pijn', 'steun', 'voetbed', 'diabete', 'reuma', 'therapeut', 'medisch', 'gezond'];
          if (sensitiveTerms.some(term => descLower.includes(term))) {
            itemXml += `\n      <g:excluded_destination>Personalized_advertising</g:excluded_destination>`;
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
