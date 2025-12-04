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

    // Fetch all products with pagination (Supabase default limit is 1000)
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
            stock_totals(qty),
            stock_by_store(qty, store_id)
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

    // Generate XML
    const xml = generateProductsXML(allProducts);
    
    // Save to storage for backup
    const fileName = tenantSlug ? `products-${tenantSlug}.xml` : 'products.xml';
    const encoder = new TextEncoder();
    const xmlBytes = encoder.encode(xml);
    
    await supabase.storage
      .from('order-exports')
      .upload(fileName, xmlBytes, {
        contentType: 'application/xml',
        upsert: true,
      });

    console.log(`Returning XML directly (${xmlBytes.length} bytes)`);
    console.log(`Saved to storage as: ${fileName}`);

    // Return XML directly with proper headers for WP All Import
    return new Response(xmlBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(xmlBytes.length),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
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
    
    // Basis product informatie
    xml += `    <artikelnummer>${escapeXML(product.sku)}</artikelnummer>\n`;
    xml += `    <webshop-titel>${escapeXML(product.title)}</webshop-titel>\n`;
    
    // Omschrijvingen
    if (product.internal_description) {
      xml += `    <interne-omschrijving>${escapeXML(product.internal_description)}</interne-omschrijving>\n`;
    }
    if (product.webshop_text) {
      xml += `    <webshop-tekst><![CDATA[${escapeCDATA(product.webshop_text)}]]></webshop-tekst>\n`;
    }
    if (product.webshop_text_en) {
      xml += `    <webshop-tekst-en><![CDATA[${escapeCDATA(product.webshop_text_en)}]]></webshop-tekst-en>\n`;
    }
    
    // Merk
    if (product.brands?.name) {
      xml += '    <merk>\n';
      xml += `      <merknaam>${escapeXML(product.brands.name)}</merknaam>\n`;
      xml += '    </merk>\n';
    }
    
    // Leverancier
    if (product.suppliers?.name) {
      xml += `    <leveranciers-omschrijving>${escapeXML(product.suppliers.name)}</leveranciers-omschrijving>\n`;
    }

    // Prijzen
    if (product.product_prices) {
      const price = product.product_prices;
      if (price.regular) {
        xml += `    <verkoopprijs>${formatPrice(price.regular)}</verkoopprijs>\n`;
      }
      if (price.list && price.list !== price.regular) {
        xml += `    <lopende-verkoopprijs>${formatPrice(price.list)}</lopende-verkoopprijs>\n`;
      }
      if (price.currency) {
        xml += `    <valuta>${escapeXML(price.currency)}</valuta>\n`;
      }
    }
    
    // Kostprijs en marges
    if (product.cost_price) {
      xml += `    <kostprijs>${formatPrice(product.cost_price)}</kostprijs>\n`;
    }
    if (product.discount_percentage) {
      xml += `    <kortingspercentage>${product.discount_percentage}</kortingspercentage>\n`;
    }

    // Kleur informatie
    if (product.color) {
      if (product.color.name) {
        xml += `    <kleur-oms>${escapeXML(product.color.name)}</kleur-oms>\n`;
        xml += `    <webfilter-kleur>${escapeXML(product.color.name)}</webfilter-kleur>\n`;
      }
      if (product.color.code) {
        xml += `    <kleur-code>${escapeXML(product.color.code)}</kleur-code>\n`;
      }
    }

    // Categorieën
    if (product.categories && Array.isArray(product.categories)) {
      product.categories.forEach((category: any, index: number) => {
        if (index < 8) {
          const categoryName = typeof category === 'object' ? category.name : String(category);
          const groupNum = index + 1;
          xml += `    <webshop-groep-${groupNum}>${escapeXML(categoryName.split(' - ')[0] || '')}</webshop-groep-${groupNum}>\n`;
          xml += `    <wgp-omschrijving-${groupNum}>${escapeXML(categoryName)}</wgp-omschrijving-${groupNum}>\n`;
        }
      });
    }

    // Artikel groep
    if (product.article_group && typeof product.article_group === 'object') {
      if (product.article_group.code) {
        xml += `    <artikelgroep-code>${escapeXML(product.article_group.code)}</artikelgroep-code>\n`;
      }
      if (product.article_group.name) {
        xml += `    <artikelgroep-naam>${escapeXML(product.article_group.name)}</artikelgroep-naam>\n`;
      }
    }

    // Attributen
    if (product.attributes) {
      const attrs = typeof product.attributes === 'string' 
        ? JSON.parse(product.attributes) 
        : product.attributes;
      
      const attrEntries = Object.entries(attrs);
      attrEntries.forEach(([key, value]: [string, any], index: number) => {
        if (index < 20) {
          const attrNum = index + 1;
          xml += `    <attribuut-nm-${attrNum}>${escapeXML(key)}</attribuut-nm-${attrNum}>\n`;
          xml += `    <attribuut-waarde-oms-${attrNum}>${escapeXML(String(value))}</attribuut-waarde-oms-${attrNum}>\n`;
        }
      });
    }

    // Afbeeldingen
    if (product.images && Array.isArray(product.images)) {
      product.images.forEach((image: string, index: number) => {
        if (index < 6) {
          const fotoNum = String(index + 1).padStart(2, '0');
          xml += `    <foto-${fotoNum}>${escapeXML(image)}</foto-${fotoNum}>\n`;
        }
      });
    }

    // SEO velden
    if (product.meta_title) {
      xml += `    <seo-titel-voor-google-feed>${escapeXML(product.meta_title)}</seo-titel-voor-google-feed>\n`;
    }
    if (product.meta_description) {
      xml += `    <meta-oms-1>${escapeXML(product.meta_description)}</meta-oms-1>\n`;
    }
    if (product.meta_keywords) {
      xml += `    <meta-keywords-1>${escapeXML(product.meta_keywords)}</meta-keywords-1>\n`;
    }
    if (product.url_key) {
      xml += `    <url-key>${escapeXML(product.url_key)}</url-key>\n`;
    }

    // Status velden
    if (product.outlet_sale) {
      xml += `    <outlet-sale>1</outlet-sale>\n`;
    }
    if (product.is_promotion) {
      xml += `    <is-promotie>1</is-promotie>\n`;
    }
    if (product.webshop_date) {
      xml += `    <webshopdatum>${escapeXML(product.webshop_date)}</webshopdatum>\n`;
    }
    if (product.plan_period) {
      xml += `    <plan-periode>${escapeXML(product.plan_period)}</plan-periode>\n`;
    }
    if (product.tax_code) {
      xml += `    <btw-code>${escapeXML(product.tax_code)}</btw-code>\n`;
    }

    // Varianten (maten) met alle details
    if (product.variants && product.variants.length > 0) {
      xml += '    <maten>\n';
      for (const variant of product.variants) {
        xml += '      <maat>\n';
        xml += `        <maat-id>${escapeXML(variant.maat_id)}</maat-id>\n`;
        xml += `        <maat-label>${escapeXML(variant.size_label)}</maat-label>\n`;
        
        if (variant.maat_web) {
          xml += `        <maat-web>${escapeXML(variant.maat_web)}</maat-web>\n`;
        }
        
        if (variant.ean) {
          xml += `        <ean-barcode>${escapeXML(variant.ean)}</ean-barcode>\n`;
        }
        
        xml += `        <actief>${variant.active ? '1' : '0'}</actief>\n`;
        
        if (variant.allow_backorder !== null && variant.allow_backorder !== undefined) {
          xml += `        <nabestellen-toegestaan>${variant.allow_backorder ? '1' : '0'}</nabestellen-toegestaan>\n`;
        }
        
        // Voorraad - totaal aantal
        xml += '        <voorraad>\n';
        const stockQty = variant.stock_totals?.qty || 0;
        xml += `          <totaal-aantal>${stockQty}</totaal-aantal>\n`;
        
        // Voorraad per filiaal
        if (variant.stock_by_store && variant.stock_by_store.length > 0) {
          for (const store of variant.stock_by_store) {
            xml += '          <filiaal>\n';
            xml += `            <filiaal-id>${escapeXML(store.store_id)}</filiaal-id>\n`;
            xml += `            <aantal>${store.qty}</aantal>\n`;
            xml += '          </filiaal>\n';
          }
        }
        
        xml += '        </voorraad>\n';
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
