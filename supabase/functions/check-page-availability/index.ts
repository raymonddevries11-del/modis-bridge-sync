// Check Page Availability — HEAD-request checker for WooCommerce product pages
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CheckResult {
  sku: string;
  product_id: string;
  slug: string;
  url: string;
  status: number | null;
  ok: boolean;
  error?: string;
  redirect_url?: string;
}

async function checkUrl(url: string, timeout = 8000): Promise<{ status: number | null; ok: boolean; error?: string; redirect_url?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'ModisPIM/1.0 (Page Availability Check)',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timer);
    const finalUrl = res.redirected ? res.url : undefined;
    return { status: res.status, ok: res.status >= 200 && res.status < 400, redirect_url: finalUrl };
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { status: null, ok: false, error: 'Timeout' };
    }
    return { status: null, ok: false, error: e.message?.substring(0, 100) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { tenantId, offset = 0, limit = 50, onlyFeedProducts = true } = await req.json();
    if (!tenantId) throw new Error('tenantId is required');

    // Get shop URL from feed config or tenant config
    const { data: feedCfg } = await supabase
      .from('google_feed_config')
      .select('shop_url')
      .eq('tenant_id', tenantId)
      .single();

    let shopUrl = feedCfg?.shop_url?.replace(/\/$/, '');
    if (!shopUrl) {
      const { data: tenantCfg } = await supabase
        .from('tenant_config')
        .select('woocommerce_url')
        .eq('tenant_id', tenantId)
        .single();
      shopUrl = tenantCfg?.woocommerce_url?.replace(/\/$/, '');
    }
    if (!shopUrl) throw new Error('Geen shop URL geconfigureerd');

    // Get woo_products with slugs (these are the products in the feed)
    let query = supabase
      .from('woo_products')
      .select('id, product_id, sku, slug, permalink, status')
      .eq('tenant_id', tenantId)
      .not('slug', 'is', null)
      .order('sku', { ascending: true })
      .range(offset, offset + limit - 1);

    if (onlyFeedProducts) {
      query = query.eq('status', 'publish');
    }

    const { data: wooProducts, error: wooErr } = await query;
    if (wooErr) throw wooErr;

    // Count total for progress
    const { count: totalCount } = await supabase
      .from('woo_products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .not('slug', 'is', null)
      .eq('status', 'publish');

    if (!wooProducts || wooProducts.length === 0) {
      return new Response(JSON.stringify({
        results: [],
        summary: { total: totalCount || 0, checked: 0, ok: 0, not_found: 0, redirected: 0, errors: 0, offset, nextOffset: null },
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const results: CheckResult[] = [];
    const CONCURRENCY = 5;

    // Process in parallel batches
    for (let i = 0; i < wooProducts.length; i += CONCURRENCY) {
      const batch = wooProducts.slice(i, i + CONCURRENCY);
      const checks = batch.map(async (wp) => {
        const slug = wp.slug;
        const url = wp.permalink || `${shopUrl}/product/${slug}/`;
        const check = await checkUrl(url);
        const result: CheckResult = {
          sku: wp.sku || '',
          product_id: wp.product_id || '',
          slug,
          url,
          status: check.status,
          ok: check.ok,
          error: check.error,
          redirect_url: check.redirect_url,
        };
        return result;
      });
      const batchResults = await Promise.all(checks);
      results.push(...batchResults);
    }

    const okCount = results.filter(r => r.ok && !r.redirect_url).length;
    const notFound = results.filter(r => r.status === 404).length;
    const redirected = results.filter(r => r.ok && r.redirect_url).length;
    const errors = results.filter(r => !r.ok && r.status !== 404).length;
    const hasMore = wooProducts.length === limit;

    return new Response(JSON.stringify({
      results: results.filter(r => !r.ok || r.redirect_url), // Only return problematic ones
      allResults: results,
      summary: {
        total: totalCount || 0,
        checked: results.length,
        ok: okCount,
        not_found: notFound,
        redirected,
        errors,
        offset,
        nextOffset: hasMore ? offset + limit : null,
      },
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('Page availability check error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
