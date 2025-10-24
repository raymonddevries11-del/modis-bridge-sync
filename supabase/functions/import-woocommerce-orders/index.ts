import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WooCommerceConfig {
  url: string;
  consumerKey: string;
  consumerSecret: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    console.log('Fetching WooCommerce orders...');

    // Get WooCommerce credentials
    const { data: config } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'woocommerce')
      .single();

    if (!config?.value) {
      throw new Error('WooCommerce configuration not found');
    }

    const wooConfig = config.value as WooCommerceConfig;

    // Fetch recent orders from WooCommerce (last 30 days, processing/completed status)
    const ordersUrl = new URL(`${wooConfig.url}/wp-json/wc/v3/orders`);
    ordersUrl.searchParams.append('per_page', '100');
    ordersUrl.searchParams.append('orderby', 'date');
    ordersUrl.searchParams.append('order', 'desc');
    ordersUrl.searchParams.append('consumer_key', wooConfig.consumerKey);
    ordersUrl.searchParams.append('consumer_secret', wooConfig.consumerSecret);
    
    const ordersResponse = await fetch(ordersUrl.toString());
    
    if (!ordersResponse.ok) {
      throw new Error(`Failed to fetch orders: ${ordersResponse.status} ${ordersResponse.statusText}`);
    }

    const wooOrders = await ordersResponse.json();
    console.log(`Found ${wooOrders.length} orders in WooCommerce`);

    let imported = 0;
    let skipped = 0;
    let exported = 0;

    for (const wooOrder of wooOrders) {
      const orderNumber = String(wooOrder.number || wooOrder.id);
      
      // Check if order already exists
      const { data: existingOrder } = await supabase
        .from('orders')
        .select('order_number')
        .eq('order_number', orderNumber)
        .maybeSingle();

      if (existingOrder) {
        console.log(`Order ${orderNumber} already exists, skipping`);
        skipped++;
        continue;
      }

      console.log(`Importing order ${orderNumber}`);

      // Prepare order data
      const orderData = {
        order_number: orderNumber,
        status: wooOrder.status,
        currency: wooOrder.currency,
        customer: {
          name: `${wooOrder.billing?.first_name || ''} ${wooOrder.billing?.last_name || ''}`.trim(),
          email: wooOrder.billing?.email || '',
          phone: wooOrder.billing?.phone || '',
        },
        billing: {
          address1: wooOrder.billing?.address_1 || '',
          address2: wooOrder.billing?.address_2 || '',
          postcode: wooOrder.billing?.postcode || '',
          city: wooOrder.billing?.city || '',
          country: wooOrder.billing?.country || '',
        },
        shipping: {
          address1: wooOrder.shipping?.address_1 || '',
          address2: wooOrder.shipping?.address_2 || '',
          postcode: wooOrder.shipping?.postcode || '',
          city: wooOrder.shipping?.city || '',
          country: wooOrder.shipping?.country || '',
        },
        totals: {
          items: parseFloat(wooOrder.total || 0),
          discount: parseFloat(wooOrder.discount_total || 0),
          shipping: parseFloat(wooOrder.shipping_total || 0),
          tax: parseFloat(wooOrder.total_tax || 0),
          total: parseFloat(wooOrder.total || 0),
        },
        paid_at: wooOrder.date_paid ? new Date(wooOrder.date_paid).toISOString() : null,
      };

      // Insert order
      const { error: orderError } = await supabase
        .from('orders')
        .insert(orderData);

      if (orderError) {
        console.error(`Failed to insert order ${orderNumber}:`, orderError);
        continue;
      }

      // Insert order lines
      const orderLines = [];
      for (const item of wooOrder.line_items || []) {
        // Extract size from variation metadata
        let size = '';
        const sizeAttr = item.meta_data?.find((m: any) => 
          m.key === 'pa_size' || m.key === 'Size' || m.display_key === 'Size'
        );
        if (sizeAttr) {
          size = sizeAttr.display_value || sizeAttr.value || '';
        }

        orderLines.push({
          order_number: orderNumber,
          sku: item.sku || '',
          ean: item.meta_data?.find((m: any) => m.key === 'ean')?.value || '',
          name: item.name || '',
          qty: item.quantity || 0,
          unit_price: parseFloat(item.price || 0),
          vat_rate: parseFloat(item.total_tax || 0) / parseFloat(item.total || 1) * 100,
          attributes: size ? { size } : {},
        });
      }

      if (orderLines.length > 0) {
        const { error: linesError } = await supabase
          .from('order_lines')
          .insert(orderLines);

        if (linesError) {
          console.error(`Failed to insert order lines for ${orderNumber}:`, linesError);
        }
      }

      imported++;

      // For processing/completed orders, trigger XML export
      if (['processing', 'completed'].includes(wooOrder.status)) {
        console.log(`Triggering XML export for order ${orderNumber}`);
        
        try {
          const exportResponse = await supabase.functions.invoke('export-orders', {
            body: { orderNumber }
          });
          
          if (exportResponse.error) {
            console.error(`Export failed for ${orderNumber}:`, exportResponse.error);
          } else {
            exported++;
          }
        } catch (exportError) {
          console.error(`Export error for ${orderNumber}:`, exportError);
        }
      }
    }

    console.log(`Import complete: ${imported} imported, ${skipped} skipped, ${exported} exported`);

    return new Response(
      JSON.stringify({
        success: true,
        imported,
        skipped,
        exported,
        total: wooOrders.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Import error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
