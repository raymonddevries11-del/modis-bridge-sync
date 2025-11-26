import "https://deno.land/x/xhr@0.1.0/mod.ts";
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
      // Parse query parameters
      const url = new URL(req.url);
      tenantSlug = url.searchParams.get('tenant');
      const tenantIdParam = url.searchParams.get('tenantId');

      if (tenantIdParam) {
        tenantId = tenantIdParam;
      } else if (tenantSlug) {
        // Look up tenant by slug
        const { data: tenant, error: tenantError } = await supabase
          .from('tenants')
          .select('id')
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
      } else {
        // No parameter provided - get the single active tenant
        const { data: tenants, error: tenantsError } = await supabase
          .from('tenants')
          .select('id')
          .eq('active', true);

        if (tenantsError || !tenants || tenants.length === 0) {
          return new Response(
            JSON.stringify({ error: 'No active tenants found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        if (tenants.length > 1) {
          return new Response(
            JSON.stringify({ error: 'Multiple tenants found. Please specify tenant using ?tenant=slug or ?tenantId=id' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        tenantId = tenants[0].id;
      }
    } else if (req.method === 'POST') {
      // Original POST handling
      const body = await req.json();
      tenantId = body.tenantId;
    }

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: 'tenantId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Exporting products for tenant ${tenantId}`);

    // Fetch all products with related data
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select(`
        *,
        brands:brand_id(name),
        suppliers:supplier_id(name),
        product_prices(*),
        variants(
          *,
          stock_totals(qty),
          stock_by_store(qty, store_id)
        )
      `)
      .eq('tenant_id', tenantId)
      .order('sku');

    if (productsError) {
      throw productsError;
    }

    console.log(`Found ${products?.length || 0} products to export`);

    // Check if direct download is requested
    const url = new URL(req.url);
    const download = url.searchParams.get('download');

    // Generate XML
    const xml = generateProductsXML(products || []);
    
    if (download === '1') {
      // Save to storage and return URL with fixed filename for WP All Import
      const fileName = tenantSlug ? `products-${tenantSlug}.xml` : 'products.xml';
      const encoder = new TextEncoder();
      const xmlBytes = encoder.encode(xml);
      
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('order-exports')
        .upload(fileName, xmlBytes, {
          contentType: 'application/xml',
          upsert: true, // Overwrite existing file for stable URL
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        throw uploadError;
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('order-exports')
        .getPublicUrl(fileName);

      console.log(`XML saved to storage: ${publicUrl}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          url: publicUrl,
          fileName: fileName,
          productCount: products?.length || 0
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }
    
    // Direct XML response for backward compatibility
    const encoder = new TextEncoder();
    const xmlBytes = encoder.encode(xml);

    return new Response(xmlBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="products.xml"',
        'Content-Length': String(xmlBytes.length),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });

  } catch (error: any) {
    console.error('Error in export-products-xml:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function generateProductsXML(products: any[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<artikelen>\n';

  for (const product of products) {
    xml += '  <artikel>\n';
    xml += `    <artnr>${escapeXML(product.sku)}</artnr>\n`;
    xml += `    <omschrijving>${escapeXML(product.title)}</omschrijving>\n`;
    
    if (product.brands?.name) {
      xml += `    <merk>${escapeXML(product.brands.name)}</merk>\n`;
    }
    
    if (product.suppliers?.name) {
      xml += `    <leverancier>${escapeXML(product.suppliers.name)}</leverancier>\n`;
    }

    // Prices
    if (product.product_prices) {
      const price = product.product_prices;
      if (price.regular) {
        xml += `    <verkoopprijs>${formatPrice(price.regular)}</verkoopprijs>\n`;
      }
      if (price.list) {
        xml += `    <adviesprijs>${formatPrice(price.list)}</adviesprijs>\n`;
      }
    }

    if (product.cost_price) {
      xml += `    <inkoopprijs>${formatPrice(product.cost_price)}</inkoopprijs>\n`;
    }

    // Categories
    if (product.categories && Array.isArray(product.categories)) {
      xml += '    <categorien>\n';
      for (const category of product.categories) {
        const categoryName = typeof category === 'object' ? category.name : String(category);
        xml += `      <categorie>${escapeXML(categoryName)}</categorie>\n`;
      }
      xml += '    </categorien>\n';
    }

    // Color
    if (product.color) {
      xml += '    <kleur>\n';
      if (product.color.code) {
        xml += `      <code>${escapeXML(product.color.code)}</code>\n`;
      }
      if (product.color.name) {
        xml += `      <naam>${escapeXML(product.color.name)}</naam>\n`;
      }
      xml += '    </kleur>\n';
    }

    // Attributes
    if (product.attributes) {
      const attrs = typeof product.attributes === 'string' 
        ? JSON.parse(product.attributes) 
        : product.attributes;
      
      if (Object.keys(attrs).length > 0) {
        xml += '    <kenmerken>\n';
        for (const [key, value] of Object.entries(attrs)) {
          xml += `      <kenmerk naam="${escapeXML(key)}">${escapeXML(String(value))}</kenmerk>\n`;
        }
        xml += '    </kenmerken>\n';
      }
    }

    // Images
    if (product.images && Array.isArray(product.images)) {
      xml += '    <fotos>\n';
      for (const image of product.images) {
        xml += `      <foto>${escapeXML(image)}</foto>\n`;
      }
      xml += '    </fotos>\n';
    }

    // Webshop text
    if (product.webshop_text) {
      xml += `    <webshop_tekst><![CDATA[${escapeCDATA(product.webshop_text)}]]></webshop_tekst>\n`;
    }

    // Variants (maten)
    if (product.variants && product.variants.length > 0) {
      xml += '    <maten>\n';
      for (const variant of product.variants) {
        xml += '      <maat>\n';
        xml += `        <maatid>${escapeXML(variant.maat_id)}</maatid>\n`;
        xml += `        <maatlabel>${escapeXML(variant.size_label)}</maatlabel>\n`;
        
        if (variant.maat_web) {
          xml += `        <maatweb>${escapeXML(variant.maat_web)}</maatweb>\n`;
        }
        
        if (variant.ean) {
          xml += `        <ean>${escapeXML(variant.ean)}</ean>\n`;
        }
        
        xml += `        <actief>${variant.active ? '1' : '0'}</actief>\n`;
        
        // Stock total
        if (variant.stock_totals) {
          xml += `        <voorraad>${variant.stock_totals.qty}</voorraad>\n`;
        }
        
        // Stock by store
        if (variant.stock_by_store && variant.stock_by_store.length > 0) {
          xml += '        <filialen>\n';
          for (const store of variant.stock_by_store) {
            xml += '          <filiaal>\n';
            xml += `            <filiaalid>${escapeXML(store.store_id)}</filiaalid>\n`;
            xml += `            <aantal>${store.qty}</aantal>\n`;
            xml += '          </filiaal>\n';
          }
          xml += '        </filialen>\n';
        }
        
        xml += '      </maat>\n';
      }
      xml += '    </maten>\n';
    }

    xml += '  </artikel>\n';
  }

  xml += '</artikelen>';
  return xml;
}

function escapeXML(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCDATA(str: string): string {
  if (!str) return '';
  // Split ]]> into separate CDATA sections: ]]]]><![CDATA[>
  return String(str).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

function formatPrice(price: number): string {
  return price.toFixed(2).replace('.', ',');
}
