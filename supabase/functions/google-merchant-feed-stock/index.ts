// Google Merchant Supplemental Stock Feed v2 — production-ready
// Mirrors exact g:id construction from primary feed so every variant matches 1:1
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
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

    // ── Load feed config ────────────────────────────────────────────
    const { data: feedConfig } = await supabase
      .from('google_feed_config')
      .select('enabled, shop_url, feed_title, currency, fallback_google_category')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!feedConfig?.enabled) {
      return new Response('Feed not enabled', { status: 404, headers: corsHeaders });
    }

    // ── Load category mappings (determines which products are in the primary feed) ──
    const { data: mappings } = await supabase
      .from('google_category_mappings')
      .select('article_group_id')
      .eq('tenant_id', tenantId);

    const mappedGroups = new Set((mappings || []).map(m => m.article_group_id));
    const hasFallback = !!feedConfig.fallback_google_category;
    const currency = feedConfig.currency || 'EUR';

    // ── Iterate products in batches ─────────────────────────────────
    const items: string[] = [];
    let offset = 0;
    const batchSize = 1000;
    let totalVariants = 0;
    let inStockCount = 0;

    while (true) {
      const { data: products, error } = await supabase
        .from('products')
        .select(`
          sku, images, article_group,
          product_prices(regular, list),
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
        // ── Mirror primary feed inclusion logic exactly ──────────────
        const articleGroupId = (product.article_group as any)?.id;
        const hasMapping = articleGroupId ? mappedGroups.has(articleGroupId) : false;
        if (!hasMapping && !hasFallback) continue;

        // Skip products with no price (primary feed does this)
        const priceData = product.product_prices as any;
        const price = Array.isArray(priceData) ? priceData[0] : priceData;
        const regularPrice = price?.regular || 0;
        if (regularPrice <= 0) continue;

        // Skip products with no images (primary feed does this)
        const images = (product.images as string[]) || [];
        if (images.length === 0) continue;

        const salePrice = price?.list && price.list < regularPrice ? price.list : null;

        const variants = (product.variants as any[]) || [];
        for (const variant of variants) {
          if (!variant.active) continue;

          // ── Stock & availability ────────────────────────────────
          const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? 0;
          let availability: string;
          if (stockQty > 0) {
            availability = 'in_stock';
            inStockCount++;
          } else if (variant.allow_backorder) {
            availability = 'backorder';
          } else {
            availability = 'out_of_stock';
          }

          // ── g:id must match primary feed exactly ────────────────
          const itemId = `${product.sku}-${variant.maat_id}`;

          let itemXml = `    <item>
      <g:id>${escapeXml(itemId)}</g:id>
      <g:availability>${availability}</g:availability>`;

          // availability_date for out_of_stock (30 days from now, matches primary feed)
          if (availability === 'out_of_stock') {
            const availDate = new Date();
            availDate.setDate(availDate.getDate() + 30);
            itemXml += `\n      <g:availability_date>${availDate.toISOString().split('T')[0]}T00:00:00+01:00</g:availability_date>`;
          }

          // Include price in supplemental feed (Google recommends for faster updates)
          itemXml += `\n      <g:price>${regularPrice.toFixed(2)} ${currency}</g:price>`;
          if (salePrice && salePrice > 0) {
            itemXml += `\n      <g:sale_price>${salePrice.toFixed(2)} ${currency}</g:sale_price>`;
          }

          itemXml += `\n    </item>`;
          items.push(itemXml);
          totalVariants++;
        }
      }

      if (products.length < batchSize) break;
      offset += batchSize;
    }

    console.log(`Stock feed generated: ${totalVariants} variants (${inStockCount} in_stock, ${totalVariants - inStockCount} out_of_stock/backorder)`);

    // ── Build RSS 2.0 feed ──────────────────────────────────────────
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml((feedConfig.feed_title || 'Google Shopping Feed') + ' - Stock')}</title>
    <link>${escapeXml(feedConfig.shop_url || '')}</link>
    <description>Supplemental stock and price feed</description>
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
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
