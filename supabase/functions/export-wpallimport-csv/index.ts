import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to escape CSV values
function escapeCSV(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // If contains comma, newline or quote, wrap in quotes and escape internal quotes
  if (str.includes(',') || str.includes('\n') || str.includes('"') || str.includes(';')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('Starting WP All Import CSV export');

    // Get active tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id, slug')
      .eq('active', true)
      .single();

    if (tenantError || !tenant) {
      throw new Error('No active tenant found');
    }

    console.log(`Exporting for tenant: ${tenant.slug}`);

    // Fetch all products with pagination
    const allProducts: any[] = [];
    let offset = 0;
    const BATCH_SIZE = 500;

    while (true) {
      const { data: products, error: productsError } = await supabase
        .from('products')
        .select(`
          id,
          sku,
          title,
          webshop_text,
          webshop_text_en,
          meta_title,
          meta_description,
          meta_keywords,
          url_key,
          images,
          categories,
          attributes,
          color,
          article_group,
          is_promotion,
          outlet_sale,
          discount_percentage,
          brands (name),
          suppliers (name),
          product_prices (regular, list, currency),
          variants (
            id,
            maat_id,
            size_label,
            maat_web,
            ean,
            active,
            allow_backorder,
            stock_totals (qty)
          )
        `)
        .eq('tenant_id', tenant.id)
        .range(offset, offset + BATCH_SIZE - 1);

      if (productsError) {
        throw new Error(`Failed to fetch products: ${productsError.message}`);
      }

      if (!products || products.length === 0) break;

      allProducts.push(...products);
      console.log(`Fetched ${allProducts.length} products so far...`);

      if (products.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    console.log(`Total products fetched: ${allProducts.length}`);

    // CSV Headers for WP All Import
    // Using parent/variation structure that WP All Import understands
    const headers = [
      'type', // simple, variable, variation
      'sku',
      'parent_sku', // for variations
      'name',
      'description',
      'short_description',
      'regular_price',
      'sale_price',
      'stock_qty',
      'stock_status', // instock, outofstock
      'manage_stock', // yes, no
      'categories', // pipe-separated: Category1|Category2
      'images', // comma-separated URLs
      'attribute:pa_maat', // Size attribute
      'attribute:pa_maat_is_visible',
      'attribute:pa_maat_is_variation',
      'meta:_ean', // EAN as meta field
      'brand',
      'supplier',
      'meta:_color_code',
      'meta:_color_name',
      // Additional attributes from product
      'attribute:pa_gender',
      'attribute:pa_wijdte',
      'attribute:pa_uitneembaar-voetbed',
      'attribute:pa_voering',
      'attribute:pa_zool',
      'attribute:pa_sluiting',
      'attribute:pa_hakhoogte',
      'attribute:pa_schachtwijdte',
      'attribute:pa_schachthoogte',
      'meta:_is_promotion',
      'meta:_outlet_sale',
      'meta:_discount_percentage',
      'tax_status',
      'tax_class',
    ];

    const rows: string[][] = [];

    for (const product of allProducts) {
      const prices = product.product_prices?.[0] || {};
      const regularPrice = prices.regular || '';
      const salePrice = prices.list && prices.list < (prices.regular || 0) ? prices.list : '';
      
      // Parse categories
      const categories = Array.isArray(product.categories) 
        ? product.categories.join('|') 
        : '';

      // Parse images
      const images = Array.isArray(product.images)
        ? product.images.map((img: any) => {
            if (typeof img === 'string') return img;
            return img.url || img.src || '';
          }).filter(Boolean).join(',')
        : '';

      // Get attributes
      const attrs = product.attributes || {};
      const getAttr = (key: string) => attrs[key] || '';

      // Color info
      const colorCode = product.color?.code || '';
      const colorName = product.color?.name || '';

      // Brand and supplier
      const brand = product.brands?.name || '';
      const supplier = product.suppliers?.name || '';

      // Get all size options for the parent product
      const variants = product.variants || [];
      const sizeOptions = variants
        .filter((v: any) => v.active)
        .map((v: any) => v.size_label || v.maat_web || '')
        .filter(Boolean)
        .join('|');

      // Parent product row (variable product)
      if (variants.length > 0) {
        rows.push([
          'variable', // type
          product.sku, // sku
          '', // parent_sku (empty for parent)
          product.title || '', // name
          product.webshop_text || '', // description
          '', // short_description
          '', // regular_price (set on variations)
          '', // sale_price (set on variations)
          '', // stock_qty (managed per variation)
          '', // stock_status
          'no', // manage_stock (managed per variation)
          categories,
          images,
          sizeOptions, // attribute:pa_maat options
          '1', // attribute visible
          '1', // attribute is variation
          '', // EAN (on variations)
          brand,
          supplier,
          colorCode,
          colorName,
          getAttr('Gender'),
          getAttr('Wijdte'),
          getAttr('Uitneembaar voetbed'),
          getAttr('Voering'),
          getAttr('Zool'),
          getAttr('Sluiting'),
          getAttr('Hakhoogte'),
          getAttr('Schachtwijdte'),
          getAttr('Schachthoogte'),
          product.is_promotion ? '1' : '0',
          product.outlet_sale ? '1' : '0',
          String(product.discount_percentage || 0),
          'taxable',
          '',
        ]);

        // Variation rows
        for (const variant of variants) {
          if (!variant.active) continue;

          const stockQty = variant.stock_totals?.qty || 0;
          const stockStatus = stockQty > 0 ? 'instock' : 'outofstock';
          const maatSuffix = variant.maat_id && variant.maat_id.includes('-') ? variant.maat_id.split('-').pop() : variant.maat_id;
          const variationSku = `${product.sku}-${maatSuffix}`;
          const sizeLabel = variant.size_label || variant.maat_web || '';

          rows.push([
            'variation', // type
            variationSku, // sku
            product.sku, // parent_sku
            '', // name (inherited)
            '', // description (inherited)
            '', // short_description
            String(regularPrice), // regular_price
            salePrice ? String(salePrice) : '', // sale_price
            String(stockQty), // stock_qty
            stockStatus, // stock_status
            'yes', // manage_stock
            '', // categories (inherited)
            '', // images (inherited)
            sizeLabel, // attribute:pa_maat value
            '', // visible (inherited)
            '', // is_variation (inherited)
            variant.ean || '', // EAN
            '', // brand (inherited)
            '', // supplier (inherited)
            '', // color code (inherited)
            '', // color name (inherited)
            '', // gender (inherited)
            '', // wijdte (inherited)
            '', // uitneembaar voetbed (inherited)
            '', // voering (inherited)
            '', // zool (inherited)
            '', // sluiting (inherited)
            '', // hakhoogte (inherited)
            '', // schachtwijdte (inherited)
            '', // schachthoogte (inherited)
            '', // is_promotion (inherited)
            '', // outlet_sale (inherited)
            '', // discount_percentage (inherited)
            '', // tax_status (inherited)
            '', // tax_class (inherited)
          ]);
        }
      } else {
        // Simple product (no variants)
        rows.push([
          'simple', // type
          product.sku,
          '',
          product.title || '',
          product.webshop_text || '',
          '',
          String(regularPrice),
          salePrice ? String(salePrice) : '',
          '0', // stock_qty
          'outofstock',
          'yes',
          categories,
          images,
          '',
          '',
          '',
          '',
          brand,
          supplier,
          colorCode,
          colorName,
          getAttr('Gender'),
          getAttr('Wijdte'),
          getAttr('Uitneembaar voetbed'),
          getAttr('Voering'),
          getAttr('Zool'),
          getAttr('Sluiting'),
          getAttr('Hakhoogte'),
          getAttr('Schachtwijdte'),
          getAttr('Schachthoogte'),
          product.is_promotion ? '1' : '0',
          product.outlet_sale ? '1' : '0',
          String(product.discount_percentage || 0),
          'taxable',
          '',
        ]);
      }
    }

    // Build CSV content
    const csvLines: string[] = [];
    csvLines.push(headers.map(escapeCSV).join(';'));
    
    for (const row of rows) {
      csvLines.push(row.map(escapeCSV).join(';'));
    }

    const csvContent = csvLines.join('\n');
    const totalVariations = rows.filter(r => r[0] === 'variation').length;
    const totalParents = rows.filter(r => r[0] === 'variable').length;

    console.log(`Generated CSV with ${totalParents} variable products and ${totalVariations} variations`);

    // Save to storage
    const filename = `wpallimport-${tenant.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    const storagePath = `exports/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from('order-exports')
      .upload(storagePath, csvContent, {
        contentType: 'text/csv',
        upsert: true,
      });

    if (uploadError) {
      console.error('Failed to upload to storage:', uploadError);
      // Return CSV directly if storage fails
      return new Response(csvContent, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // Get public URL
    const { data: publicUrl } = supabase.storage
      .from('order-exports')
      .getPublicUrl(storagePath);

    console.log(`CSV saved to: ${publicUrl.publicUrl}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Exported ${totalParents} products with ${totalVariations} variations`,
      filename,
      downloadUrl: publicUrl.publicUrl,
      stats: {
        totalProducts: allProducts.length,
        variableProducts: totalParents,
        simpleProducts: rows.filter(r => r[0] === 'simple').length,
        variations: totalVariations,
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('Export error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: errorMessage 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
