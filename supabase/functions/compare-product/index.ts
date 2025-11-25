import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooCommerceConfig {
  url: string;
  consumer_key: string;
  consumer_secret: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { productId, tenantId } = await req.json();

    if (!productId || !tenantId) {
      throw new Error("productId and tenantId are required");
    }

    // Get tenant config
    const { data: tenantConfig, error: configError } = await supabaseClient
      .from("tenant_config")
      .select("*")
      .eq("tenant_id", tenantId)
      .single();

    if (configError || !tenantConfig) {
      throw new Error(`Failed to get tenant config: ${configError?.message}`);
    }

    const wooConfig: WooCommerceConfig = {
      url: tenantConfig.woocommerce_url,
      consumer_key: tenantConfig.woocommerce_consumer_key,
      consumer_secret: tenantConfig.woocommerce_consumer_secret,
    };

    // Get product from database
    const { data: dbProduct, error: dbError } = await supabaseClient
      .from("products")
      .select(`
        *,
        brands(id, name),
        suppliers(id, name),
        product_prices(*),
        variants(*)
      `)
      .eq("id", productId)
      .single();

    if (dbError || !dbProduct) {
      throw new Error(`Failed to get product from database: ${dbError?.message}`);
    }

    // Try to find product in WooCommerce by SKU
    const searchUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/products`);
    searchUrl.searchParams.append("consumer_key", wooConfig.consumer_key);
    searchUrl.searchParams.append("consumer_secret", wooConfig.consumer_secret);
    searchUrl.searchParams.append("sku", dbProduct.sku);

    const searchResponse = await fetch(searchUrl.toString());
    
    if (!searchResponse.ok) {
      return new Response(
        JSON.stringify({
          database: dbProduct,
          woocommerce: null,
          differences: {
            message: "Product not found in WooCommerce",
            exists: false
          }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const wooProducts = await searchResponse.json();
    
    if (!wooProducts || wooProducts.length === 0) {
      return new Response(
        JSON.stringify({
          database: dbProduct,
          woocommerce: null,
          differences: {
            message: "Product not found in WooCommerce",
            exists: false
          }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const wooProduct = wooProducts[0];

    // Compare fields
    const differences: any = {
      exists: true,
      fields: {}
    };

    // Compare basic fields
    if (dbProduct.title !== wooProduct.name) {
      differences.fields.title = {
        database: dbProduct.title,
        woocommerce: wooProduct.name
      };
    }

    if (dbProduct.sku !== wooProduct.sku) {
      differences.fields.sku = {
        database: dbProduct.sku,
        woocommerce: wooProduct.sku
      };
    }

    // Compare prices
    const dbRegularPrice = dbProduct.product_prices?.regular ? parseFloat(dbProduct.product_prices.regular) : 0;
    const wooRegularPrice = wooProduct.regular_price ? parseFloat(wooProduct.regular_price) : 0;
    
    if (Math.abs(dbRegularPrice - wooRegularPrice) > 0.01) {
      differences.fields.regular_price = {
        database: dbRegularPrice.toFixed(2),
        woocommerce: wooRegularPrice.toFixed(2)
      };
    }

    const dbSalePrice = dbProduct.product_prices?.list ? parseFloat(dbProduct.product_prices.list) : 0;
    const wooSalePrice = wooProduct.sale_price ? parseFloat(wooProduct.sale_price) : 0;
    
    if (Math.abs(dbSalePrice - wooSalePrice) > 0.01) {
      differences.fields.sale_price = {
        database: dbSalePrice.toFixed(2),
        woocommerce: wooSalePrice.toFixed(2)
      };
    }

    // Compare description
    if (dbProduct.webshop_text && dbProduct.webshop_text !== wooProduct.description) {
      differences.fields.description = {
        database: dbProduct.webshop_text?.substring(0, 100) + "...",
        woocommerce: wooProduct.description?.substring(0, 100) + "..."
      };
    }

    // Compare short description
    if (dbProduct.meta_description && dbProduct.meta_description !== wooProduct.short_description) {
      differences.fields.short_description = {
        database: dbProduct.meta_description?.substring(0, 100) + "...",
        woocommerce: wooProduct.short_description?.substring(0, 100) + "..."
      };
    }

    // Compare categories
    const dbCategories = dbProduct.categories || [];
    const wooCategories = wooProduct.categories || [];
    
    if (JSON.stringify(dbCategories) !== JSON.stringify(wooCategories)) {
      differences.fields.categories = {
        database: dbCategories.map((c: any) => c.name).join(", "),
        woocommerce: wooCategories.map((c: any) => c.name).join(", ")
      };
    }

    // Compare attributes
    const dbAttributes = dbProduct.attributes || {};
    const wooAttributes = wooProduct.attributes || [];
    
    const dbAttrCount = Object.keys(dbAttributes).length;
    const wooAttrCount = wooAttributes.length;
    
    if (dbAttrCount !== wooAttrCount) {
      differences.fields.attributes_count = {
        database: dbAttrCount,
        woocommerce: wooAttrCount
      };
    }

    // Compare stock for variants
    const dbVariants = dbProduct.variants || [];
    const wooVariations = wooProduct.variations || [];
    
    if (dbVariants.length !== wooVariations.length) {
      differences.fields.variants_count = {
        database: dbVariants.length,
        woocommerce: wooVariations.length
      };
    }

    // Compare images
    const dbImages = dbProduct.images || [];
    const wooImages = wooProduct.images || [];
    
    if (dbImages.length !== wooImages.length) {
      differences.fields.images_count = {
        database: dbImages.length,
        woocommerce: wooImages.length
      };
    }

    console.log(`Compared product ${dbProduct.sku}, found ${Object.keys(differences.fields).length} differences`);

    return new Response(
      JSON.stringify({
        database: dbProduct,
        woocommerce: wooProduct,
        differences
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error("Error comparing product:", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
