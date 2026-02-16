// Google Merchant Feed Validator - pre-submission validation
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { tenantId } = await req.json();
    if (!tenantId) {
      return new Response(JSON.stringify({ error: 'Missing tenantId' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Load feed config
    const { data: feedConfig } = await supabase
      .from('google_feed_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!feedConfig?.enabled) {
      return new Response(JSON.stringify({ error: 'Feed not enabled' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Load category mappings
    const { data: mappings } = await supabase
      .from('google_category_mappings')
      .select('article_group_id')
      .eq('tenant_id', tenantId);
    const mappedGroupIds = new Set((mappings || []).map(m => m.article_group_id));
    const fallbackCategory = feedConfig.fallback_google_category || null;

    // Load WooCommerce slugs and images
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

    // Issue collectors
    const imageIssues: { sku: string; title: string; reason: string }[] = [];
    const urlIssues: { sku: string; title: string; reason: string }[] = [];
    const stockIssues: { sku: string; title: string; reason: string }[] = [];
    const priceIssues: { sku: string; title: string; reason: string }[] = [];
    const categoryIssues: { sku: string; title: string; reason: string }[] = [];
    const gtinIssues: { sku: string; title: string; reason: string }[] = [];

    let totalProducts = 0;
    let totalVariants = 0;
    let validItems = 0;
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const { data: products, error } = await supabase
        .from('products')
        .select(`
          id, sku, title, images, color, url_key, article_group,
          product_prices(regular, list),
          variants!variants_product_id_fkey(
            id, maat_id, size_label, ean, active,
            stock_totals(qty)
          )
        `)
        .eq('tenant_id', tenantId)
        .range(offset, offset + batchSize - 1);

      if (error) throw error;
      if (!products || products.length === 0) break;

      for (const product of products) {
        totalProducts++;
        const articleGroupId = (product.article_group as any)?.id;
        const hasCategoryMapping = articleGroupId ? mappedGroupIds.has(articleGroupId) : false;

        // Category check
        if (!hasCategoryMapping && !fallbackCategory) {
          categoryIssues.push({ sku: product.sku, title: product.title, reason: 'Geen Google categorie mapping en geen fallback' });
        }

        // Image check
        const rawImages = (product.images as string[]) || [];
        let validImages = rawImages.filter((url: string) => {
          if (!url || typeof url !== 'string') return false;
          if (!/^https?:\/\//i.test(url)) return false;
          if (url.includes('supabase.co/storage')) return false;
          return true;
        });
        if (validImages.length === 0) {
          const wooImages = wooImageMap.get(product.id);
          if (wooImages && wooImages.length > 0) {
            validImages = wooImages;
          }
        }
        if (validImages.length === 0) {
          const reason = rawImages.length === 0
            ? 'Geen afbeeldingen'
            : rawImages.every(u => u?.includes('supabase.co/storage'))
              ? 'Alleen interne storage URLs'
              : 'Ongeldige afbeeldings-URLs';
          imageIssues.push({ sku: product.sku, title: product.title, reason });
        }

        // URL check
        const wooSlug = wooSlugMap.get(product.id);
        const cleanUrlKey = product.url_key ? product.url_key.replace(/-+$/, '').replace(/-nvt$/, '') : null;
        if (!wooSlug && (!cleanUrlKey || cleanUrlKey.length <= 2)) {
          urlIssues.push({
            sku: product.sku,
            title: product.title,
            reason: !wooSlug ? 'Geen WooCommerce slug' : 'Ongeldige url_key',
          });
        }

        // Price check
        const priceData = product.product_prices as any;
        const price = Array.isArray(priceData) ? priceData[0] : priceData;
        const regularPrice = price?.regular || 0;
        if (regularPrice <= 0) {
          priceIssues.push({ sku: product.sku, title: product.title, reason: `Prijs: ${regularPrice}` });
        }

        // Variant + stock + GTIN checks
        const variants = (product.variants as any[]) || [];
        const activeVariants = variants.filter(v => v.active);

        if (activeVariants.length === 0) {
          stockIssues.push({ sku: product.sku, title: product.title, reason: 'Geen actieve varianten' });
        }

        let hasAnyStock = false;
        for (const variant of activeVariants) {
          totalVariants++;
          const stockQty = variant.stock_totals?.[0]?.qty ?? variant.stock_totals?.qty ?? null;
          if (stockQty === null) {
            stockIssues.push({
              sku: product.sku,
              title: product.title,
              reason: `Variant ${variant.maat_id}: geen voorraaddata`,
            });
          } else if (stockQty > 0) {
            hasAnyStock = true;
          }

          // GTIN check
          const ean = (variant.ean || '').trim();
          if (!ean) {
            gtinIssues.push({
              sku: product.sku,
              title: product.title,
              reason: `Variant ${variant.maat_id}: geen EAN`,
            });
          } else if (!/^\d{8,14}$/.test(ean)) {
            gtinIssues.push({
              sku: product.sku,
              title: product.title,
              reason: `Variant ${variant.maat_id}: ongeldig EAN "${ean}"`,
            });
          }

          // Count as valid if all core checks pass
          const hasImage = validImages.length > 0;
          const hasUrl = !!wooSlug || (!!cleanUrlKey && cleanUrlKey.length > 2);
          const hasPrice = regularPrice > 0;
          const hasCategory = hasCategoryMapping || !!fallbackCategory;
          if (hasImage && hasUrl && hasPrice && hasCategory) {
            validItems++;
          }
        }
      }

      if (products.length < batchSize) break;
      offset += batchSize;
    }

    // Deduplicate by SKU for product-level issues
    const dedup = (arr: { sku: string; title: string; reason: string }[]) => {
      const seen = new Map<string, { sku: string; title: string; reason: string }>();
      for (const item of arr) {
        if (!seen.has(item.sku)) seen.set(item.sku, item);
      }
      return [...seen.values()];
    };

    const result = {
      summary: {
        totalProducts,
        totalVariants,
        validItems,
        timestamp: new Date().toISOString(),
      },
      issues: {
        images: { count: dedup(imageIssues).length, items: dedup(imageIssues).slice(0, 100) },
        urls: { count: dedup(urlIssues).length, items: dedup(urlIssues).slice(0, 100) },
        stock: { count: dedup(stockIssues).length, items: dedup(stockIssues).slice(0, 100) },
        prices: { count: dedup(priceIssues).length, items: dedup(priceIssues).slice(0, 100) },
        categories: { count: dedup(categoryIssues).length, items: dedup(categoryIssues).slice(0, 100) },
        gtins: { count: dedup(gtinIssues).length, items: dedup(gtinIssues).slice(0, 100) },
      },
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Validation error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
