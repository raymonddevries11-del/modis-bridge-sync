// Google Merchant Supplemental Stock Feed - availability only
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function escapeXml(str: string): string {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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

    if (!tenantId && req.method === 'POST') {
      try { const body = await req.json(); tenantId = body.tenantId || null; } catch { /* ignore */ }
    }

    if (!tenantId) {
      return new Response('Missing tenantId', { status: 400, headers: corsHeaders });
    }

    // Load feed config for shop_url and enabled check
    const { data: feedConfig } = await supabase
      .from('google_feed_config')
      .select('enabled, shop_url, feed_title, fallback_google_category')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!feedConfig?.enabled) {
      return new Response('Feed not enabled', { status: 404, headers: corsHeaders });
    }

    // Load category mappings to know which products are in primary feed
    const { data: mappings } = await supabase
      .from('google_category_mappings')
      .select('article_group_id')
      .eq('tenant_id', tenantId);

    const mappedGroups = new Set((mappings || []).map(m => m.article_group_id));
    const hasFallback = !!feedConfig.fallback_google_category;

    const items: string[] = [];
    let offset = 0;
    const batchSize = 1000;

    while (true) {
      const { data: products, error } = await supabase
        .from('products')
        .select(`
          sku, images, article_group,
          product_prices(regular),
          variants!variants_product_id_fkey(
            maat_id, active, allow_backorder,
            stock_totals(qty)
          )
        `)
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (error) throw error;
      if (!products || products.length === 0) break;

      for (const product of products) {
        const articleGroupId = (product.article_group as any)?.id;
        const hasMapping = articleGroupId ? mappedGroups.has(articleGroupId) : false;
        if (!hasMapping && !hasFallback) continue;

        const priceData = product.product_prices as any;
        const price = Array.isArray(priceData) ? priceData[0] : priceData;
        if (!price?.regular || price.regular <= 0) continue;

        const images = (product.images as string[]) || [];
        if (images.length === 0) continue;

        const variants = (product.variants as any[]) || [];
        for (const variant of variants) {
          if (!variant.active) continue;

          const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
          let availability: string;
          if (stockQty > 0) {
            availability = 'in_stock';
          } else if (variant.allow_backorder) {
            availability = 'backorder';
          } else {
            availability = 'out_of_stock';
          }

          const itemId = `${product.sku}-${variant.maat_id}`;
          items.push(`    <item>\n      <g:id>${escapeXml(itemId)}</g:id>\n      <g:availability>${availability}</g:availability>\n    </item>`);
        }
      }

      if (products.length < batchSize) break;
      offset += batchSize;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml((feedConfig.feed_title || 'Stock Feed') + ' - Availability')}</title>
    <link>${escapeXml(feedConfig.shop_url || '')}</link>
${items.join('\n')}
  </channel>
</rss>`;

    return new Response(xml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=900',
      },
    });
  } catch (error: any) {
    console.error('Error generating stock feed:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
