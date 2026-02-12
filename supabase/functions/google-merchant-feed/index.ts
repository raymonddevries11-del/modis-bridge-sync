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

    // Load products with variants, prices, brands in batches
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
        
        // Skip products without category mapping
        if (!mapping) continue;

        const brandName = (product.brands as any)?.name || '';
        const price = (product.product_prices as any)?.[0];
        const regularPrice = price?.regular || 0;
        const salePrice = price?.list && price.list < regularPrice ? price.list : null;
        const currency = price?.currency || feedConfig.currency || 'EUR';
        const images = (product.images as string[]) || [];
        const color = (product.color as any);
        const description = product.webshop_text || product.meta_description || product.title;
        const shopUrl = feedConfig.shop_url?.replace(/\/$/, '') || '';

        // Each active variant = unique product
        const variants = (product.variants as any[]) || [];
        for (const variant of variants) {
          if (!variant.active) continue;

          const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
          const availability = stockQty > 0 ? 'in_stock' : 'out_of_stock';
          const itemId = `${product.sku}-${variant.maat_id}`;
          const sizeLabel = variant.maat_web || variant.size_label;
          const productUrl = product.url_key 
            ? `${shopUrl}/product/${product.url_key}` 
            : `${shopUrl}/?s=${product.sku}`;
          const imageLink = images.length > 0 ? images[0] : '';

          let itemXml = `    <item>
      <g:id>${escapeXml(itemId)}</g:id>
      <g:title>${escapeXml(product.title)}${sizeLabel ? ' - ' + escapeXml(sizeLabel) : ''}</g:title>
      <g:description>${escapeXml(description)}</g:description>
      <g:link>${escapeXml(productUrl)}</g:link>
      <g:image_link>${escapeXml(imageLink as string)}</g:image_link>`;

          // Additional images
          for (let i = 1; i < Math.min(images.length, 10); i++) {
            itemXml += `\n      <g:additional_image_link>${escapeXml(images[i] as string)}</g:additional_image_link>`;
          }

          itemXml += `
      <g:availability>${availability}</g:availability>
      <g:price>${regularPrice.toFixed(2)} ${currency}</g:price>`;

          if (salePrice) {
            itemXml += `\n      <g:sale_price>${salePrice.toFixed(2)} ${currency}</g:sale_price>`;
          }

          itemXml += `
      <g:brand>${escapeXml(brandName)}</g:brand>
      <g:condition>${escapeXml(mapping.condition || 'new')}</g:condition>
      <g:google_product_category>${escapeXml(mapping.google_category)}</g:google_product_category>`;

          if (variant.ean) {
            itemXml += `\n      <g:gtin>${escapeXml(variant.ean)}</g:gtin>`;
          } else {
            itemXml += `\n      <g:identifier_exists>false</g:identifier_exists>`;
          }

          if (sizeLabel) {
            itemXml += `\n      <g:size>${escapeXml(sizeLabel)}</g:size>`;
          }

          if (color?.label) {
            itemXml += `\n      <g:color>${escapeXml(color.label)}</g:color>`;
          }

          if (mapping.gender) {
            itemXml += `\n      <g:gender>${escapeXml(mapping.gender)}</g:gender>`;
          }

          if (mapping.age_group) {
            itemXml += `\n      <g:age_group>${escapeXml(mapping.age_group)}</g:age_group>`;
          }

          if (mapping.material) {
            itemXml += `\n      <g:material>${escapeXml(mapping.material)}</g:material>`;
          }

          // Item group ID links variants together
          itemXml += `\n      <g:item_group_id>${escapeXml(product.sku)}</g:item_group_id>`;

          // Shipping
          if (feedConfig.shipping_country) {
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
