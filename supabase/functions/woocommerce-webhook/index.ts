import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wc-webhook-signature',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    console.log('WooCommerce webhook received');

    // Verify webhook signature
    const signature = req.headers.get('x-wc-webhook-signature');
    const webhookSecret = Deno.env.get('WOOCOMMERCE_WEBHOOK_SECRET');

    if (!webhookSecret) {
      console.error('WOOCOMMERCE_WEBHOOK_SECRET not configured');
      return new Response(
        JSON.stringify({ error: 'Webhook not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse the request body
    const contentType = req.headers.get('content-type') || '';
    let bodyText: string;
    let wooOrder;

    if (contentType.includes('application/json')) {
      // Get raw body for signature verification
      bodyText = await req.text();
      
      // Verify HMAC signature for non-test webhooks
      if (signature && webhookSecret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(webhookSecret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );

        const expectedSig = await crypto.subtle.sign(
          'HMAC',
          key,
          encoder.encode(bodyText)
        );

        const expectedBase64 = btoa(String.fromCharCode(...new Uint8Array(expectedSig)));

        if (signature !== expectedBase64) {
          console.error('Invalid webhook signature');
          return new Response(
            JSON.stringify({ error: 'Invalid signature' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        console.log('Webhook signature verified successfully');
      }

      // Parse JSON after verification
      wooOrder = JSON.parse(bodyText);
    } else {
      // Test webhook or other format - return success
      bodyText = await req.text();
      console.log('Non-JSON webhook received:', bodyText);
      return new Response(
        JSON.stringify({ message: 'Webhook endpoint ready' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const orderNumber = String(wooOrder.number || wooOrder.id);
    console.log(`Processing order ${orderNumber} from webhook`);

    // Determine tenant from webhook source or _links
    let tenantId: string | null = null;
    
    // Try to get the source URL from the order's _links or webhook header
    const sourceUrl = req.headers.get('x-wc-webhook-source') || 
                      wooOrder._links?.self?.[0]?.href ||
                      '';
    
    console.log(`Webhook source URL: ${sourceUrl}`);
    
    if (sourceUrl) {
      // Extract domain from source URL
      try {
        const url = new URL(sourceUrl);
        const domain = url.hostname;
        console.log(`Looking for tenant with domain: ${domain}`);
        
        // Find tenant by matching WooCommerce URL
        const { data: tenantConfig } = await supabase
          .from('tenant_config')
          .select('tenant_id, woocommerce_url')
          .single();
        
        if (tenantConfig) {
          // Check if the configured WooCommerce URL matches
          const configuredDomain = new URL(tenantConfig.woocommerce_url).hostname;
          if (domain === configuredDomain || domain.includes(configuredDomain.replace('www.', '')) || configuredDomain.includes(domain.replace('www.', ''))) {
            tenantId = tenantConfig.tenant_id;
            console.log(`Matched tenant: ${tenantId}`);
          }
        }
      } catch (urlError) {
        console.error('Error parsing source URL:', urlError);
      }
    }
    
    // Fallback: get the first active tenant if only one exists
    if (!tenantId) {
      const { data: tenants } = await supabase
        .from('tenants')
        .select('id')
        .eq('active', true);
      
      if (tenants && tenants.length === 1) {
        tenantId = tenants[0].id;
        console.log(`Using single active tenant: ${tenantId}`);
      } else {
        console.warn(`Could not determine tenant, found ${tenants?.length || 0} active tenants`);
      }
    }

    // Check if order already exists
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('order_number')
      .eq('order_number', orderNumber)
      .maybeSingle();

    if (existingOrder) {
      console.log(`Order ${orderNumber} already exists, skipping import`);
      return new Response(
        JSON.stringify({ message: 'Order already exists' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Importing new order ${orderNumber} for tenant ${tenantId}`);

    // Prepare order data
    const orderData = {
      order_number: orderNumber,
      status: wooOrder.status,
      currency: wooOrder.currency || 'EUR',
      tenant_id: tenantId,
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
      throw orderError;
    }

    console.log(`Order ${orderNumber} inserted successfully`);

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
        throw linesError;
      }
    }

    console.log(`Order lines inserted for ${orderNumber}`);

    // Trigger XML export to SFTP for processing/completed orders
    if (['processing', 'completed'].includes(wooOrder.status)) {
      console.log(`Triggering XML export for order ${orderNumber}`);
      
      try {
        const exportResponse = await supabase.functions.invoke('export-orders', {
          body: { orderNumber, tenantId }
        });
        
        if (exportResponse.error) {
          console.error(`Export failed for ${orderNumber}:`, exportResponse.error);
        } else {
          console.log(`XML export triggered for ${orderNumber}`);
        }
      } catch (exportError) {
        console.error(`Export error for ${orderNumber}:`, exportError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        orderNumber,
        message: 'Order imported and export triggered',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Webhook error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
