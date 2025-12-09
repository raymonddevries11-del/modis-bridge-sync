import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { tenantId, limit = 50 } = await req.json();

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: 'tenantId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Importing missing order lines for tenant ${tenantId}, limit: ${limit}`);

    // Get tenant config for WooCommerce credentials
    const { data: tenantConfig, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !tenantConfig) {
      console.error('Failed to get tenant config:', configError);
      return new Response(
        JSON.stringify({ error: 'Tenant config not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret } = tenantConfig;

    // Find orders without order_lines
    const { data: ordersWithoutLines, error: ordersError } = await supabase
      .from('orders')
      .select(`
        order_number,
        order_lines(id)
      `)
      .eq('tenant_id', tenantId)
      .limit(limit);

    if (ordersError) {
      console.error('Failed to fetch orders:', ordersError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch orders' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Filter orders with no lines
    const ordersToProcess = ordersWithoutLines?.filter(o => !o.order_lines || o.order_lines.length === 0) || [];
    console.log(`Found ${ordersToProcess.length} orders without line items`);

    if (ordersToProcess.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No orders need line items', processed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const order of ordersToProcess) {
      try {
        // Fetch order from WooCommerce
        const wooUrl = `${woocommerce_url}/wp-json/wc/v3/orders/${order.order_number}`;
        const auth = btoa(`${woocommerce_consumer_key}:${woocommerce_consumer_secret}`);

        console.log(`Fetching order ${order.order_number} from WooCommerce...`);

        const wooResponse = await fetch(wooUrl, {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          }
        });

        if (!wooResponse.ok) {
          const errorText = await wooResponse.text();
          console.error(`WooCommerce API error for order ${order.order_number}:`, wooResponse.status, errorText);
          errors.push(`Order ${order.order_number}: WooCommerce API error ${wooResponse.status}`);
          failed++;
          continue;
        }

        const wooOrder = await wooResponse.json();

        if (!wooOrder.line_items || wooOrder.line_items.length === 0) {
          console.log(`Order ${order.order_number} has no line items in WooCommerce`);
          continue;
        }

        // Insert order lines
        const orderLines = wooOrder.line_items.map((item: any) => ({
          order_number: order.order_number,
          tenant_id: tenantId,
          sku: item.sku || `woo-${item.product_id}`,
          ean: item.meta_data?.find((m: any) => m.key === '_ean')?.value || '',
          name: item.name,
          qty: item.quantity,
          unit_price: parseFloat(item.price) || 0,
          vat_rate: 21, // Default Dutch VAT
          attributes: extractAttributes(item)
        }));

        const { error: insertError } = await supabase
          .from('order_lines')
          .insert(orderLines);

        if (insertError) {
          console.error(`Failed to insert lines for order ${order.order_number}:`, insertError);
          errors.push(`Order ${order.order_number}: Insert failed - ${insertError.message}`);
          failed++;
          continue;
        }

        console.log(`✓ Imported ${orderLines.length} lines for order ${order.order_number}`);
        processed++;

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`Error processing order ${order.order_number}:`, error);
        errors.push(`Order ${order.order_number}: ${errMsg}`);
        failed++;
      }
    }

    console.log(`\n=== Import Complete ===`);
    console.log(`Processed: ${processed}, Failed: ${failed}`);

    return new Response(
      JSON.stringify({
        success: true,
        processed,
        failed,
        total: ordersToProcess.length,
        errors: errors.slice(0, 10) // Return first 10 errors
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Import failed:', error);
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function extractAttributes(item: any): Record<string, string> {
  const attributes: Record<string, string> = {};
  
  // Extract variation attributes
  if (item.variation_id && item.meta_data) {
    for (const meta of item.meta_data) {
      if (meta.key && meta.key.startsWith('pa_')) {
        attributes[meta.key.replace('pa_', '')] = meta.value;
      }
      if (meta.key === 'Size' || meta.key === 'Maat') {
        attributes['size'] = meta.value;
      }
    }
  }
  
  return attributes;
}
