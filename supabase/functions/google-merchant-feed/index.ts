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
 * Build an optimized title: Brand + ProductType + Color + Size
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
    parts.push(productType);
  } else {
    // Try first category name
    const cats = product.categories as any[];
    if (cats?.length) {
      const catName = typeof cats[0] === 'object' ? cats[0].name : String(cats[0]);
      if (catName) parts.push(catName);
    }
  }

  // Color
  const color = product.color as any;
  if (color?.label || color?.name) {
    parts.push(color.label || color.name);
  }

  // Size
  if (sizeLabel) {
    parts.push(`Maat ${sizeLabel}`);
  }

  // Fallback: if we only have brand, add original title (cleaned)
  if (parts.length <= 1) {
    parts.push(product.title);
  }

  return parts.join(' ');
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
    const tenantId = url.searchParams.get('tenantId');

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
        const effectiveGender = mapping?.gender || null;
        const effectiveAgeGroup = mapping?.age_group || null;
        const effectiveMaterial = mapping?.material || null;

        const brandName = (product.brands as any)?.name || '';
        const price = (product.product_prices as any)?.[0];
        const regularPrice = price?.regular || 0;
        const salePrice = price?.list && price.list < regularPrice ? price.list : null;
        const currency = price?.currency || feedConfig.currency || 'EUR';
        const images = (product.images as string[]) || [];
        const color = (product.color as any);
        const description = product.webshop_text || product.meta_description || product.title;
        const shopUrl = feedConfig.shop_url?.replace(/\/$/, '') || '';

        // 1️⃣ Skip products with no real price (price must never be 0)
        if (regularPrice <= 0) continue;

        // 2️⃣ Product URL: prefer direct PDP via url_key, fallback to search
        const productUrl = product.url_key
          ? `${shopUrl}/product/${product.url_key}`
          : `${shopUrl}/?s=${product.sku}`;

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

          // 3️⃣ Optimized title: Brand + Type + Color + Size
          const optimizedTitle = buildTitle(product, brandName, sizeLabel);

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

          // Availability & price (price is always the real price, never 0)
          itemXml += `
      <g:availability>${availability}</g:availability>
      <g:price>${regularPrice.toFixed(2)} ${currency}</g:price>`;

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
