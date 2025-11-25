import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    const body = await req.json().catch(() => ({}));
    const tenantId = body.tenantId;

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: 'Missing tenantId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Fetching WooCommerce orders for tenant ${tenantId}...`);

    // Get tenant configuration
    const { data: config, error: configError } = await supabase
      .from('tenant_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .single();

    if (configError || !config) {
      throw new Error('Tenant configuration not found');
    }

    const wooConfig = {
      url: config.woocommerce_url,
      consumerKey: config.woocommerce_consumer_key,
      consumerSecret: config.woocommerce_consumer_secret,
    } as WooCommerceConfig;

    // Fetch recent orders from WooCommerce with automatic HTTP fallback for SSL errors
    let ordersUrl = `${wooConfig.url}/wp-json/wc/v3/orders?per_page=100&orderby=date&order=desc&consumer_key=${wooConfig.consumerKey}&consumer_secret=${wooConfig.consumerSecret}`;
    
    let ordersResponse;
    let usedHttpFallback = false;
    
    try {
      console.log('Attempting HTTPS connection to WooCommerce...');
      ordersResponse = await fetch(ordersUrl);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Automatic HTTP fallback for SSL certificate errors on temporary domains
      if (errorMessage.includes('invalid peer certificate') || errorMessage.includes('UnknownIssuer')) {
        console.log('SSL certificate error detected, falling back to HTTP...');
        ordersUrl = ordersUrl.replace('https://', 'http://');
        usedHttpFallback = true;
        
        try {
          ordersResponse = await fetch(ordersUrl);
          console.log('HTTP fallback successful');
        } catch (httpError) {
          const httpErrorMessage = httpError instanceof Error ? httpError.message : String(httpError);
          throw new Error(`Both HTTPS and HTTP failed. HTTPS error: ${errorMessage}. HTTP error: ${httpErrorMessage}`);
        }
      } else {
        throw error;
      }
    }
    
    if (!ordersResponse.ok) {
      throw new Error(`Failed to fetch orders: ${ordersResponse.status} ${ordersResponse.statusText}`);
    }

    const wooOrders = await ordersResponse.json();
    console.log(`Found ${wooOrders.length} orders in WooCommerce${usedHttpFallback ? ' (using HTTP fallback)' : ''}`);


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
        tenant_id: tenantId,
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
          tenant_id: tenantId,
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
            body: { orderNumber, tenantId }
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

    // Add changelog entry
    if (imported > 0 || exported > 0) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'ORDERS_IMPORTED',
        description: `${imported} orders geïmporteerd, ${exported} geëxporteerd`,
        metadata: {
          imported,
          skipped,
          exported,
          total: wooOrders.length
        }
      });
    }

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
