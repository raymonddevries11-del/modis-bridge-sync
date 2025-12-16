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
      
      // Get tenant slug for filename
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

    console.log(`Exporting WooCommerce CSV for tenant ${tenantId}`);

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

    console.log(`Found ${allProducts.length} total products to export`);

    // Generate CSV
    const csv = generateWooCommerceCSV(allProducts);
    
    // Save to storage
    const fileName = tenantSlug ? `woocommerce-import-${tenantSlug}.csv` : 'woocommerce-import.csv';
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

function generateWooCommerceCSV(products: any[]): string {
  // WooCommerce CSV Import columns
  const headers = [
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
    'Meta: _ywbc_barcode_display_value'
  ];

  const rows: string[][] = [];
  rows.push(headers);

  for (const product of products) {
    const hasVariants = product.variants && product.variants.length > 0;
    const productType = hasVariants ? 'variable' : 'simple';
    
    // Build categories string (pipe separated with hierarchy)
    let categories = '';
    if (product.categories && Array.isArray(product.categories)) {
      categories = product.categories
        .map((cat: any) => typeof cat === 'object' ? cat.name : String(cat))
        .join(', ');
    }
    
    // Build images string (comma separated URLs)
    let images = '';
    if (product.images && Array.isArray(product.images)) {
      images = product.images.join(', ');
    }
    
    // Get prices
    const regularPrice = product.product_prices?.regular || '';
    const salePrice = product.product_prices?.list && product.product_prices.list !== product.product_prices.regular 
      ? product.product_prices.list 
      : '';
    
    // Build attributes for variable products
    let attr1Name = '', attr1Values = '', attr1Visible = '', attr1Global = '';
    let attr2Name = '', attr2Values = '', attr2Visible = '', attr2Global = '';
    let attr3Name = '', attr3Values = '', attr3Visible = '', attr3Global = '';
    let attr4Name = '', attr4Values = '', attr4Visible = '', attr4Global = '';
    let attr5Name = '', attr5Values = '', attr5Visible = '', attr5Global = '';
    
    if (hasVariants) {
      // Maat attribute with all size values
      attr1Name = 'Maat';
      attr1Values = product.variants
        .filter((v: any) => v.active)
        .map((v: any) => v.size_label || v.maat_web || v.maat_id)
        .join(', ');
      attr1Visible = '1';
      attr1Global = '1';
    }
    
    // Add product attributes (Wijdte, etc.)
    if (product.attributes && typeof product.attributes === 'object') {
      const attrs = Object.entries(product.attributes);
      
      // Skip Maat if already added, add other attributes
      let attrIndex = hasVariants ? 2 : 1; // Start at 2 if Maat is already attr1
      
      for (const [key, value] of attrs) {
        if (key.toLowerCase() === 'maat') continue; // Skip maat, already handled
        if (attrIndex > 5) break;
        
        const attrName = key;
        const attrValue = String(value);
        
        switch (attrIndex) {
          case 1:
            attr1Name = attrName;
            attr1Values = attrValue;
            attr1Visible = '1';
            attr1Global = '1';
            break;
          case 2:
            attr2Name = attrName;
            attr2Values = attrValue;
            attr2Visible = '1';
            attr2Global = '1';
            break;
          case 3:
            attr3Name = attrName;
            attr3Values = attrValue;
            attr3Visible = '1';
            attr3Global = '1';
            break;
          case 4:
            attr4Name = attrName;
            attr4Values = attrValue;
            attr4Visible = '1';
            attr4Global = '1';
            break;
          case 5:
            attr5Name = attrName;
            attr5Values = attrValue;
            attr5Visible = '1';
            attr5Global = '1';
            break;
        }
        attrIndex++;
      }
    }
    
    // Calculate total stock for parent product
    const totalStock = hasVariants 
      ? product.variants.reduce((sum: number, v: any) => sum + (v.stock_totals?.qty || 0), 0)
      : 0;
    
    // Parent product row
    const parentRow: string[] = [
      productType,                              // Type
      product.sku,                              // SKU
      product.title,                            // Name
      '1',                                      // Published
      '0',                                      // Is featured?
      'visible',                                // Visibility in catalog
      product.internal_description || '',       // Short description
      product.webshop_text || '',              // Description
      'taxable',                                // Tax status
      product.tax_code || '',                   // Tax class
      totalStock > 0 ? '1' : '0',              // In stock?
      hasVariants ? '' : String(totalStock),   // Stock (empty for variable)
      '0',                                      // Backorders allowed?
      '0',                                      // Sold individually?
      '',                                       // Weight
      '',                                       // Length
      '',                                       // Width
      '',                                       // Height
      '1',                                      // Allow customer reviews?
      '',                                       // Purchase note
      String(salePrice),                        // Sale price
      String(regularPrice),                     // Regular price
      categories,                               // Categories
      product.brands?.name || '',              // Tags (using brand as tag)
      '',                                       // Shipping class
      images,                                   // Images
      '',                                       // Download limit
      '',                                       // Download expiry days
      '',                                       // Parent
      '',                                       // Grouped products
      '',                                       // Upsells
      '',                                       // Cross-sells
      '',                                       // External URL
      '',                                       // Button text
      '0',                                      // Position
      attr1Name,                                // Attribute 1 name
      attr1Values,                              // Attribute 1 value(s)
      attr1Visible,                             // Attribute 1 visible
      attr1Global,                              // Attribute 1 global
      attr2Name,                                // Attribute 2 name
      attr2Values,                              // Attribute 2 value(s)
      attr2Visible,                             // Attribute 2 visible
      attr2Global,                              // Attribute 2 global
      attr3Name,                                // Attribute 3 name
      attr3Values,                              // Attribute 3 value(s)
      attr3Visible,                             // Attribute 3 visible
      attr3Global,                              // Attribute 3 global
      attr4Name,                                // Attribute 4 name
      attr4Values,                              // Attribute 4 value(s)
      attr4Visible,                             // Attribute 4 visible
      attr4Global,                              // Attribute 4 global
      attr5Name,                                // Attribute 5 name
      attr5Values,                              // Attribute 5 value(s)
      attr5Visible,                             // Attribute 5 visible
      attr5Global,                              // Attribute 5 global
      ''                                        // Meta: barcode
    ];
    
    rows.push(parentRow);
    
    // Add variation rows
    if (hasVariants) {
      for (const variant of product.variants) {
        if (!variant.active) continue;
        
        const variantStock = variant.stock_totals?.qty || 0;
        const sizeLabel = variant.size_label || variant.maat_web || variant.maat_id;
        const variationSKU = `${product.sku}-${variant.maat_id}`;
        
        const variationRow: string[] = [
          'variation',                            // Type
          variationSKU,                           // SKU
          '',                                     // Name (inherited from parent)
          '1',                                    // Published
          '0',                                    // Is featured?
          'visible',                              // Visibility in catalog
          '',                                     // Short description
          '',                                     // Description
          'taxable',                              // Tax status
          product.tax_code || '',                 // Tax class
          variantStock > 0 ? '1' : '0',          // In stock?
          String(variantStock),                   // Stock
          variant.allow_backorder ? '1' : '0',   // Backorders allowed?
          '0',                                    // Sold individually?
          '',                                     // Weight
          '',                                     // Length
          '',                                     // Width
          '',                                     // Height
          '1',                                    // Allow customer reviews?
          '',                                     // Purchase note
          String(salePrice),                      // Sale price (inherited)
          String(regularPrice),                   // Regular price (inherited)
          '',                                     // Categories
          '',                                     // Tags
          '',                                     // Shipping class
          '',                                     // Images
          '',                                     // Download limit
          '',                                     // Download expiry days
          product.sku,                            // Parent (parent SKU)
          '',                                     // Grouped products
          '',                                     // Upsells
          '',                                     // Cross-sells
          '',                                     // External URL
          '',                                     // Button text
          '0',                                    // Position
          'Maat',                                 // Attribute 1 name
          sizeLabel,                              // Attribute 1 value(s) - single value for variation
          '1',                                    // Attribute 1 visible
          '1',                                    // Attribute 1 global
          '',                                     // Attribute 2 name
          '',                                     // Attribute 2 value(s)
          '',                                     // Attribute 2 visible
          '',                                     // Attribute 2 global
          '',                                     // Attribute 3 name
          '',                                     // Attribute 3 value(s)
          '',                                     // Attribute 3 visible
          '',                                     // Attribute 3 global
          '',                                     // Attribute 4 name
          '',                                     // Attribute 4 value(s)
          '',                                     // Attribute 4 visible
          '',                                     // Attribute 4 global
          '',                                     // Attribute 5 name
          '',                                     // Attribute 5 value(s)
          '',                                     // Attribute 5 visible
          '',                                     // Attribute 5 global
          variant.ean || ''                       // Meta: barcode (EAN)
        ];
        
        rows.push(variationRow);
      }
    }
  }

  // Convert to CSV string
  return rows.map(row => row.map(cell => escapeCSV(cell)).join(',')).join('\n');
}

function escapeCSV(value: any): string {
  if (value === null || value === undefined) return '';
  
  const str = String(value);
  
  // Check if we need to quote the field
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    // Escape double quotes by doubling them
    return '"' + str.replace(/"/g, '""') + '"';
  }
  
  return str;
}
