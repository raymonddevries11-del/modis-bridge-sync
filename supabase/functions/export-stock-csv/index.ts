import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let tenantId: string | null = null;
    let tenantSlug: string | null = null;

    // Handle both GET and POST requests
    if (req.method === 'GET') {
      const url = new URL(req.url);
      tenantSlug = url.searchParams.get('tenant');
      const tenantIdParam = url.searchParams.get('tenantId');

      if (tenantIdParam) {
        tenantId = tenantIdParam;
      } else if (tenantSlug) {
        const { data: tenant, error: tenantError } = await supabase
          .from('tenants')
          .select('id, slug')
          .eq('slug', tenantSlug)
          .eq('active', true)
          .single();

        if (tenantError || !tenant) {
          return new Response(
            JSON.stringify({ error: `Tenant not found with slug: ${tenantSlug}` }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        tenantId = tenant.id;
        tenantSlug = tenant.slug;
      } else {
        const { data: tenants, error: tenantsError } = await supabase
          .from('tenants')
          .select('id, slug')
          .eq('active', true);

        if (tenantsError || !tenants || tenants.length === 0) {
          return new Response(
            JSON.stringify({ error: 'No active tenants found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        if (tenants.length > 1) {
          return new Response(
            JSON.stringify({ error: 'Multiple tenants found. Please specify tenant using ?tenant=slug' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        tenantId = tenants[0].id;
        tenantSlug = tenants[0].slug;
      }
    } else if (req.method === 'POST') {
      const body = await req.json();
      tenantId = body.tenantId;
      
      const { data: tenant } = await supabase
        .from('tenants')
        .select('slug')
        .eq('id', tenantId)
        .single();
      tenantSlug = tenant?.slug;
    }

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: 'tenantId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Exporting stock & prices CSV for tenant ${tenantId}`);

    // Fetch all products with only price and variant stock data
    const allProducts: any[] = [];
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data: products, error: productsError } = await supabase
        .from('products')
        .select(`
          sku,
          product_prices(regular, list),
          variants(
            maat_id,
            size_label,
            maat_web,
            active,
            stock_totals(qty)
          )
        `)
        .eq('tenant_id', tenantId)
        .order('sku')
        .range(offset, offset + pageSize - 1);

      if (productsError) {
        throw productsError;
      }

      if (products && products.length > 0) {
        allProducts.push(...products);
        console.log(`Fetched ${products.length} products (offset: ${offset}, total: ${allProducts.length})`);
        offset += pageSize;
        hasMore = products.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    console.log(`Found ${allProducts.length} total products for stock/price export`);

    // Generate minimal CSV
    const csv = generateStockPriceCSV(allProducts);
    
    // Save to storage
    const fileName = tenantSlug ? `woocommerce-stock-prices-${tenantSlug}.csv` : 'woocommerce-stock-prices.csv';
    const encoder = new TextEncoder();
    const csvBytes = encoder.encode(csv);
    
    await supabase.storage
      .from('order-exports')
      .upload(fileName, csvBytes, {
        contentType: 'text/csv; charset=utf-8',
        upsert: true,
      });

    console.log(`CSV saved to storage as: ${fileName} (${csvBytes.length} bytes)`);

    return new Response(csvBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(csvBytes.length),
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0, s-maxage=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'CDN-Cache-Control': 'no-store',
        'Cloudflare-CDN-Cache-Control': 'no-store',
        'Surrogate-Control': 'no-store',
      },
    });

  } catch (error: any) {
    console.error('Error in export-woocommerce-stock-prices:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function formatPrice(price: any): string {
  if (price === null || price === undefined || price === '') return '';
  const num = Number(price);
  if (isNaN(num)) return '';
  return num.toFixed(2);
}

function generateStockPriceCSV(products: any[]): string {
  // Minimal WooCommerce CSV columns for stock & price updates only
  const headers = [
    'SKU',
    'Regular price',
    'Sale price',
    'Stock',
    'In stock?'
  ];

  const rows: string[][] = [];
  rows.push(headers);

  for (const product of products) {
    const activeVariants = product.variants?.filter((v: any) => v.active) || [];
    const hasVariants = activeVariants.length > 0;
    
    // Get prices
    const regularPrice = formatPrice(product.product_prices?.regular);
    const salePrice = product.product_prices?.list && 
                      product.product_prices.list !== product.product_prices.regular 
      ? formatPrice(product.product_prices.list) 
      : '';
    
    // Calculate total stock for parent
    const totalStock = hasVariants
      ? activeVariants.reduce((sum: number, v: any) => sum + (v.stock_totals?.qty || 0), 0)
      : 0;
    
    // Parent product row (for variable products, stock is managed at variation level)
    const parentRow: string[] = [
      product.sku,
      regularPrice,
      salePrice,
      hasVariants ? '' : String(totalStock),  // Empty for variable products
      totalStock > 0 ? '1' : '0'
    ];
    
    rows.push(parentRow);
    
    // Add variation rows
    if (hasVariants) {
      for (const variant of activeVariants) {
        const variantStock = variant.stock_totals?.qty || 0;
        const sizeLabel = variant.size_label || variant.maat_web || variant.maat_id;
        
        // Build variation SKU
        const variationSKU = (() => {
          const raw = String(variant.maat_id || '').trim();
          if (raw && raw.startsWith(`${product.sku}-`)) return raw;
          const suffix = raw || String(sizeLabel || '').trim();
          return suffix ? `${product.sku}-${suffix}` : product.sku;
        })();
        
        const variationRow: string[] = [
          variationSKU,
          regularPrice,
          salePrice,
          String(variantStock),
          variantStock > 0 ? '1' : '0'
        ];
        
        rows.push(variationRow);
      }
    }
  }

  return rows.map(row => row.map(cell => escapeCSV(cell)).join(',')).join('\n');
}

function escapeCSV(value: any): string {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  return '"' + str.replace(/"/g, '""') + '"';
}
