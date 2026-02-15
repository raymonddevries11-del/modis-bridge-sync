// Google Merchant Local Inventory Feed — production-ready
// Outputs per-store stock with correct local inventory attributes
// Uses Atom feed format as required by Google's local inventory specification
// Mirrors exact g:id construction from primary feed (sku-maat_id)
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

// Google Business Profile store code
const GOOGLE_STORE_CODE = 'Kosterschoenmode1';

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

    // ── Load category mappings ──────────────────────────────────────
    const { data: mappings } = await supabase
      .from('google_category_mappings')
      .select('article_group_id')
      .eq('tenant_id', tenantId);

    const mappedGroups = new Set((mappings || []).map(m => m.article_group_id));
    const hasFallback = !!feedConfig.fallback_google_category;
    const currency = feedConfig.currency || 'EUR';

    // ── Pre-load all stock_by_store into a map: variant_id → [{store_id, qty}] ──
    const storeStockMap = new Map<string, { store_id: string; qty: number }[]>();
    let stockOffset = 0;
    const stockBatch = 1000;
    while (true) {
      const { data: stockRows, error: stockErr } = await supabase
        .from('stock_by_store')
        .select('variant_id, store_id, qty')
        .range(stockOffset, stockOffset + stockBatch - 1);
      if (stockErr) throw stockErr;
      if (!stockRows || stockRows.length === 0) break;
      for (const row of stockRows) {
        const existing = storeStockMap.get(row.variant_id) || [];
        existing.push({ store_id: row.store_id, qty: row.qty });
        storeStockMap.set(row.variant_id, existing);
      }
      if (stockRows.length < stockBatch) break;
      stockOffset += stockBatch;
    }

    // Collect unique store IDs for fallback
    const allStoreIds = new Set<string>();
    for (const entries of storeStockMap.values()) {
      for (const e of entries) allStoreIds.add(e.store_id);
    }

    // ── Also load stock_totals as fallback ───────────────────────────
    const stockTotalsMap = new Map<string, number>();
    let totalsOffset = 0;
    while (true) {
      const { data: totalsRows, error: totErr } = await supabase
        .from('stock_totals')
        .select('variant_id, qty')
        .range(totalsOffset, totalsOffset + stockBatch - 1);
      if (totErr) throw totErr;
      if (!totalsRows || totalsRows.length === 0) break;
      for (const row of totalsRows) {
        stockTotalsMap.set(row.variant_id, row.qty);
      }
      if (totalsRows.length < stockBatch) break;
      totalsOffset += stockBatch;
    }

    // ── Iterate products in batches ─────────────────────────────────
    const entries: string[] = [];
    let offset = 0;
    const batchSize = 1000;
    let totalItems = 0;

    // De-duplicate: only emit one entry per itemId (aggregate stock across stores)
    const emittedIds = new Set<string>();

    while (true) {
      const { data: products, error } = await supabase
        .from('products')
        .select(`
          sku, images, article_group,
          product_prices(regular, list),
          variants!variants_product_id_fkey(
            id, maat_id, active, allow_backorder
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
        const regularPrice = price?.regular || 0;
        if (regularPrice <= 0) continue;

        const images = (product.images as string[]) || [];
        if (images.length === 0) continue;

        const salePrice = price?.list && price.list < regularPrice ? price.list : null;

        const variants = (product.variants as any[]) || [];
        for (const variant of variants) {
          if (!variant.active) continue;

          const itemId = `${product.sku}-${variant.maat_id}`;
          if (emittedIds.has(itemId)) continue;
          emittedIds.add(itemId);

          // Aggregate qty across all stores for this variant
          const storeEntries = storeStockMap.get(variant.id);
          let totalQty = 0;

          if (storeEntries && storeEntries.length > 0) {
            totalQty = storeEntries.reduce((sum, s) => sum + s.qty, 0);
          } else {
            totalQty = stockTotalsMap.get(variant.id) ?? 0;
          }

          // Google local inventory availability values (underscores required)
          const availability = totalQty > 0
            ? 'in_stock'
            : (variant.allow_backorder ? 'backorder' : 'out_of_stock');

          let entryXml = `  <entry>
    <g:store_code>${GOOGLE_STORE_CODE}</g:store_code>
    <g:id>${escapeXml(itemId)}</g:id>
    <g:quantity>${totalQty}</g:quantity>
    <g:price>${regularPrice.toFixed(2)} ${currency}</g:price>
    <g:availability>${availability}</g:availability>`;

          if (salePrice && salePrice > 0) {
            entryXml += `\n    <g:sale_price>${salePrice.toFixed(2)} ${currency}</g:sale_price>`;
          }

          entryXml += `\n  </entry>`;
          entries.push(entryXml);
          totalItems++;
        }
      }

      if (products.length < batchSize) break;
      offset += batchSize;
    }

    console.log(`Local inventory feed generated: ${totalItems} items for store ${GOOGLE_STORE_CODE}`);

    // ── Build Atom feed (Google's expected format for local inventory) ──
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">
  <title>${escapeXml((feedConfig.feed_title || 'Local Inventory') + ' - Local Inventory')}</title>
${entries.join('\n')}
</feed>`;

    return new Response(xml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=900',
      },
    });
  } catch (error: any) {
    console.error('Error generating local inventory feed:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
