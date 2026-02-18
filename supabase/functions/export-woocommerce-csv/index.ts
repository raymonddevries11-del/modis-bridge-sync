// Export WooCommerce CSV - v2.1
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
    let exportType: string = 'full'; // 'full' or 'stock'

    // Handle both GET and POST requests
    if (req.method === 'GET') {
      const url = new URL(req.url);
      tenantSlug = url.searchParams.get('tenant');
      const tenantIdParam = url.searchParams.get('tenantId');
      exportType = url.searchParams.get('type') || 'full';

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
      exportType = body.type || 'full';
      
      // Get tenant slug for filename
      const { data: tenant } = await supabase
        .from('tenants')
        .select('slug')
        .eq('id', tenantId)
        .single();
      tenantSlug = tenant?.slug;

      // Support missingOnly flag to export only products not yet in WooCommerce
      if (body.missingOnly) {
        exportType = 'missing';
      }
    }

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: 'tenantId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // If type=stock, use lightweight stock/price export
    if (exportType === 'stock') {
      return await handleStockExport(supabase, tenantId, tenantSlug);
    }

    console.log(`Exporting WooCommerce CSV for tenant ${tenantId} (type: ${exportType})`);

    // If missingOnly, first get product_ids that already exist in woo_products
    let existingProductIds: Set<string> | null = null;
    if (exportType === 'missing') {
      const existingIds = new Set<string>();
      let wpOffset = 0;
      let wpHasMore = true;
      while (wpHasMore) {
        const { data: wpRows } = await supabase
          .from('woo_products')
          .select('product_id')
          .eq('tenant_id', tenantId)
          .not('product_id', 'is', null)
          .range(wpOffset, wpOffset + 999);
        if (wpRows && wpRows.length > 0) {
          for (const r of wpRows) if (r.product_id) existingIds.add(r.product_id);
          wpOffset += 1000;
          wpHasMore = wpRows.length === 1000;
        } else {
          wpHasMore = false;
        }
      }
      existingProductIds = existingIds;
      console.log(`Found ${existingIds.size} products already in WooCommerce, will export only missing ones`);
    }

    // Fetch all products with pagination
    const allProducts: any[] = [];
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data: products, error: productsError } = await supabase
        .from('products')
        .select(`
          *,
          brands:brand_id(name),
          suppliers:supplier_id(name),
          product_prices(*),
          variants(
            *,
            stock_totals(qty)
          ),
          product_ai_content(
            ai_title,
            ai_short_description,
            ai_long_description,
            ai_meta_title,
            ai_meta_description,
            status
          )
        `)
        .eq('tenant_id', tenantId)
        .order('sku')
        .range(offset, offset + pageSize - 1);

      if (productsError) {
        throw productsError;
      }

      if (products && products.length > 0) {
        for (const p of products) {
          // If missingOnly, skip products that already exist in WooCommerce
          if (existingProductIds && existingProductIds.has(p.id)) continue;
          allProducts.push(p);
        }
        console.log(`Fetched ${products.length} products (offset: ${offset}, kept: ${allProducts.length})`);
        offset += pageSize;
        hasMore = products.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    console.log(`Found ${allProducts.length} products to export${exportType === 'missing' ? ' (missing only)' : ''}`);

    // Generate CSV
    const csv = generateWooCommerceCSV(allProducts, exportType);
    
    // Save to storage
    const filePrefix = exportType === 'missing' ? 'woocommerce-missing' : 'woocommerce-import';
    const fileName = tenantSlug ? `${filePrefix}-${tenantSlug}.csv` : `${filePrefix}.csv`;
    const encoder = new TextEncoder();
    const csvBytes = encoder.encode(csv);
    
    await supabase.storage
      .from('order-exports')
      .upload(fileName, csvBytes, {
        contentType: 'text/csv; charset=utf-8',
        upsert: true,
      });

    console.log(`CSV saved to storage as: ${fileName} (${csvBytes.length} bytes)`);

    // Return CSV directly
    return new Response(csvBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(csvBytes.length),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });

  } catch (error: any) {
    console.error('Error in export-woocommerce-csv:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Format price with period as decimal separator (WooCommerce standard)
function formatPrice(price: any): string {
  if (price === null || price === undefined || price === '') return '';
  const num = Number(price);
  if (isNaN(num)) return '';
  // Always use period as decimal separator, 2 decimal places
  return num.toFixed(2);
}

function generateWooCommerceCSV(products: any[], exportType: string = 'full'): string {
  // WooCommerce CSV Import columns - standard format
  // IMPORTANT: For attribute values, WooCommerce expects comma-separated terms.
  const headers = [
    'ID',
    'Type',
    'SKU',
    'Name',
    'Published',
    'Is featured?',
    'Visibility in catalog',
    'Short description',
    'Description',
    'Tax status',
    'Tax class',
    'In stock?',
    'Stock',
    'Low stock amount',
    'Backorders allowed?',
    'Sold individually?',
    'Weight (kg)',
    'Length (cm)',
    'Width (cm)',
    'Height (cm)',
    'Allow customer reviews?',
    'Purchase note',
    'Sale price',
    'Regular price',
    'Categories',
    'Tags',
    'Brands',
    'Shipping class',
    'Images',
    'Download limit',
    'Download expiry days',
    'Parent',
    'Grouped products',
    'Upsells',
    'Cross-sells',
    'External URL',
    'Button text',
    'Position',
    'Attribute 1 name',
    'Attribute 1 value(s)',
    'Attribute 1 visible',
    'Attribute 1 global',
    'Attribute 2 name',
    'Attribute 2 value(s)',
    'Attribute 2 visible',
    'Attribute 2 global',
    'Attribute 3 name',
    'Attribute 3 value(s)',
    'Attribute 3 visible',
    'Attribute 3 global',
    'Attribute 4 name',
    'Attribute 4 value(s)',
    'Attribute 4 visible',
    'Attribute 4 global',
    'Attribute 5 name',
    'Attribute 5 value(s)',
    'Attribute 5 visible',
    'Attribute 5 global',
    'Attribute 6 name',
    'Attribute 6 value(s)',
    'Attribute 6 visible',
    'Attribute 6 global',
    'Attribute 7 name',
    'Attribute 7 value(s)',
    'Attribute 7 visible',
    'Attribute 7 global',
    'Attribute 8 name',
    'Attribute 8 value(s)',
    'Attribute 8 visible',
    'Attribute 8 global',
    'Attribute 9 name',
    'Attribute 9 value(s)',
    'Attribute 9 visible',
    'Attribute 9 global',
    'Attribute 10 name',
    'Attribute 10 value(s)',
    'Attribute 10 visible',
    'Attribute 10 global',
    'Meta: _ywbc_barcode_display_value'
  ];

  const rows: string[][] = [];
  rows.push(headers);

  for (const product of products) {
    const hasVariants = product.variants && product.variants.length > 0;
    const activeVariants = hasVariants ? product.variants.filter((v: any) => v.active) : [];
    const productType = activeVariants.length > 0 ? 'variable' : 'simple';
    
    // Build categories string (comma separated - WooCommerce native importer)
    let categories = '';
    if (product.categories && Array.isArray(product.categories)) {
      categories = product.categories
        .map((cat: any) => typeof cat === 'object' ? cat.name : String(cat))
        .filter((c: string) => c && c.trim())
        .join(', ');
    }
    
    // Build images string - COMMA separated (NO SPACES) for WooCommerce native importer
    // The pipe separator with spaces causes URL encoding issues
    // When exporting missing-only, skip images to avoid 404 errors during WC import
    let images = '';
    if (exportType !== 'missing' && product.images && Array.isArray(product.images)) {
      images = product.images
        .filter((img: any) => img && typeof img === 'string' && img.trim())
        .join(',');
    }
    
    // Get prices - ensure proper decimal format
    const regularPrice = formatPrice(product.product_prices?.regular);
    const salePrice = product.product_prices?.list && 
                      product.product_prices.list !== product.product_prices.regular 
      ? formatPrice(product.product_prices.list) 
      : '';
    
    // Build product attributes array (max 10 attributes for WooCommerce)
    const productAttributes: { name: string; values: string; visible: string; global: string }[] = [];
    
    // Add Maat attribute FIRST for variable products (this is the variation attribute)
    // global = 1 for GLOBAL attribute - enables proper filtering in WooCommerce
    if (activeVariants.length > 0) {
      const sizeValues = activeVariants
        .map((v: any) => v.size_label || v.maat_web || v.maat_id)
        .filter((s: string) => s)
        .join(', ');  // Comma-separated terms so WooCommerce creates/links individual global terms
      
      productAttributes.push({
        name: 'Maat',
        values: sizeValues,
        visible: '1',
        global: '1'  // GLOBAL attribute enables filtering
      });
    }
    
    // Add Brand/Merk as global attribute for product filtering
    if (product.brands?.name) {
      productAttributes.push({
        name: 'Merk',
        values: product.brands.name,
        visible: '1',
        global: '1'  // GLOBAL attribute enables filtering
      });
    }
    
    // Add product attributes from the attributes JSON field
    if (product.attributes && typeof product.attributes === 'object') {
      const skipKeys = ['maat', 'artikelnummer', 'merk']; // Skip these, handled separately
      
      for (const [key, value] of Object.entries(product.attributes)) {
        if (skipKeys.includes(key.toLowerCase())) continue;
        if (productAttributes.length >= 10) break;
        if (!value || String(value).trim() === '') continue;
        
        productAttributes.push({
          name: key,
          values: String(value),
          visible: '1',
          global: '1'
        });
      }
    }
    
    // Pad attributes to 10
    while (productAttributes.length < 10) {
      productAttributes.push({ name: '', values: '', visible: '', global: '' });
    }
    
    // Calculate total stock for parent product
    const totalStock = activeVariants.length > 0
      ? activeVariants.reduce((sum: number, v: any) => sum + (v.stock_totals?.qty || 0), 0)
      : 0;
    
    // Get brand for Brands taxonomy column
    const brands = product.brands?.name || '';
    const tags = '';  // Tags column left empty
    
    // Check for approved AI content - use it instead of original content
    const aiContent = product.product_ai_content;
    const hasApprovedAi = aiContent && aiContent.status === 'approved';
    
    // Use AI content if approved, otherwise fallback to original
    const productTitle = hasApprovedAi && aiContent.ai_title ? aiContent.ai_title : product.title;
    const shortDescription = hasApprovedAi && aiContent.ai_short_description ? aiContent.ai_short_description : (product.internal_description || '');
    const longDescription = hasApprovedAi && aiContent.ai_long_description ? aiContent.ai_long_description : (product.webshop_text || '');
    
    // Parent product row
    const parentRow: string[] = [
      '',                                         // ID (empty for new products)
      productType,                                // Type
      product.sku,                                // SKU
      productTitle,                               // Name (AI or original)
      '1',                                        // Published
      '0',                                        // Is featured?
      'visible',                                  // Visibility in catalog
      shortDescription,                           // Short description (AI or original)
      longDescription,                            // Description (AI or original)
      'taxable',                                  // Tax status
      '',                                         // Tax class
      totalStock > 0 ? '1' : '0',                // In stock?
      productType === 'simple' ? String(totalStock) : '', // Stock (empty for variable)
      '',                                         // Low stock amount
      '0',                                        // Backorders allowed?
      '0',                                        // Sold individually?
      '',                                         // Weight
      '',                                         // Length
      '',                                         // Width
      '',                                         // Height
      '1',                                        // Allow customer reviews?
      '',                                         // Purchase note
      salePrice,                                  // Sale price
      regularPrice,                               // Regular price
      categories,                                 // Categories
      tags,                                       // Tags
      brands,                                     // Brands (taxonomy)
      '',                                         // Shipping class
      images,                                     // Images
      '',                                         // Download limit
      '',                                         // Download expiry days
      '',                                         // Parent (empty for parent product)
      '',                                         // Grouped products
      '',                                         // Upsells
      '',                                         // Cross-sells
      '',                                         // External URL
      '',                                         // Button text
      '0',                                        // Position
      // Attributes 1-10
      productAttributes[0].name,
      productAttributes[0].values,
      productAttributes[0].visible,
      productAttributes[0].global,
      productAttributes[1].name,
      productAttributes[1].values,
      productAttributes[1].visible,
      productAttributes[1].global,
      productAttributes[2].name,
      productAttributes[2].values,
      productAttributes[2].visible,
      productAttributes[2].global,
      productAttributes[3].name,
      productAttributes[3].values,
      productAttributes[3].visible,
      productAttributes[3].global,
      productAttributes[4].name,
      productAttributes[4].values,
      productAttributes[4].visible,
      productAttributes[4].global,
      productAttributes[5].name,
      productAttributes[5].values,
      productAttributes[5].visible,
      productAttributes[5].global,
      productAttributes[6].name,
      productAttributes[6].values,
      productAttributes[6].visible,
      productAttributes[6].global,
      productAttributes[7].name,
      productAttributes[7].values,
      productAttributes[7].visible,
      productAttributes[7].global,
      productAttributes[8].name,
      productAttributes[8].values,
      productAttributes[8].visible,
      productAttributes[8].global,
      productAttributes[9].name,
      productAttributes[9].values,
      productAttributes[9].visible,
      productAttributes[9].global,
      ''                                          // Meta: barcode
    ];
    
    rows.push(parentRow);
    
    // Add variation rows for variable products
    if (activeVariants.length > 0) {
      let position = 0;
      
      for (const variant of activeVariants) {
        position++;
        
        const variantStock = variant.stock_totals?.qty || 0;
        const sizeLabel = variant.size_label || variant.maat_web || variant.maat_id;

        // Build a stable variation SKU.
        // Some datasets may already have a prefixed value stored in maat_id (e.g. "{productSku}-...")
        // so we avoid double-prefixing.
        const variationSKU = (() => {
          const raw = String(variant.maat_id || '').trim();
          if (raw && raw.startsWith(`${product.sku}-`)) return raw;
          const suffix = raw || String(sizeLabel || '').trim();
          return suffix ? `${product.sku}-${suffix}` : product.sku;
        })();
        
        const variationRow: string[] = [
          '',                                     // ID
          'variation',                            // Type
          variationSKU,                           // SKU
          `${productTitle} - ${sizeLabel}`,       // Name (use AI title if approved)
          '1',                                    // Published
          '0',                                    // Is featured?
          'visible',                              // Visibility in catalog
          '',                                     // Short description
          '',                                     // Description
          'taxable',                              // Tax status
          '',                                     // Tax class
          variantStock > 0 ? '1' : '0',          // In stock?
          String(variantStock),                   // Stock
          '',                                     // Low stock amount
          variant.allow_backorder ? '1' : '0',   // Backorders allowed?
          '0',                                    // Sold individually?
          '',                                     // Weight
          '',                                     // Length
          '',                                     // Width
          '',                                     // Height
          '1',                                    // Allow customer reviews?
          '',                                     // Purchase note
          salePrice,                              // Sale price (from parent)
          regularPrice,                           // Regular price (from parent)
          '',                                     // Categories
          '',                                     // Tags
          '',                                     // Brands
          '',                                     // Shipping class
          '',                                     // Images
          '',                                     // Download limit
          '',                                     // Download expiry days
          product.sku,                            // Parent (parent SKU!)
          '',                                     // Grouped products
          '',                                     // Upsells
          '',                                     // Cross-sells
          '',                                     // External URL
          '',                                     // Button text
          String(position),                       // Position
          // Attribute 1 = Maat (the variation attribute)
          'Maat',
          sizeLabel,                              // Single value for this variation
          '1',
          '1',  // GLOBAL attribute - enables filtering
          // Attributes 2-10 (empty for variations)
          '', '', '', '',
          '', '', '', '',
          '', '', '', '',
          '', '', '', '',
          '', '', '', '',
          '', '', '', '',
          '', '', '', '',
          '', '', '', '',
          '', '', '', '',
          variant.ean || ''                       // Meta: barcode (EAN)
        ];
        
        rows.push(variationRow);
      }
    }
  }

  // Convert to CSV string with proper escaping
  // All fields are quoted to prevent issues with commas in values
  return rows.map(row => row.map(cell => escapeCSV(cell)).join(',')).join('\n');
}

function escapeCSV(value: any): string {
  if (value === null || value === undefined) return '""';
  
  const str = String(value);
  
  // Always quote fields to prevent issues with commas, line breaks, and special chars
  // Double any existing quotes within the string
  return '"' + str.replace(/"/g, '""') + '"';
}

// Lightweight stock & price export function
async function handleStockExport(supabase: any, tenantId: string, tenantSlug: string | null): Promise<Response> {
  console.log(`Exporting lightweight stock & prices CSV for tenant ${tenantId}`);

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

  console.log(`Stock CSV saved to storage as: ${fileName} (${csvBytes.length} bytes)`);

  return new Response(csvBytes, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(csvBytes.length),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
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
