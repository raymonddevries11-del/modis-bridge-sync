import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface OrderLine {
  sku: string;
  ean?: string;
  name: string;
  qty: number;
  unit_price: number;
  vat_rate: number;
  attributes?: Record<string, any>;
}

interface OrderRequest {
  order_number: string;
  status: string;
  currency?: string;
  totals: Record<string, any>;
  customer: Record<string, any>;
  billing: Record<string, any>;
  shipping: Record<string, any>;
  lines: OrderLine[];
  paid_at?: string;
}

async function verifyApiKey(supabase: any, authHeader: string | null): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7);
  
  const { data: apiKeys } = await supabase
    .from('api_keys')
    .select('id, key_hash')
    .eq('key_hash', token);

  if (!apiKeys || apiKeys.length === 0) {
    return false;
  }

  // Update last_used_at
  await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKeys[0].id);

  return true;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  try {
    // POST /orders
    if (req.method === 'POST' && pathParts.length === 2 && pathParts[1] === 'orders-api') {
      const authHeader = req.headers.get('authorization');
      const isValid = await verifyApiKey(supabase, authHeader);
      
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const orderData: OrderRequest = await req.json();

      // Validate required fields
      if (!orderData.order_number || !orderData.status || !orderData.lines?.length) {
        return new Response(JSON.stringify({ error: 'Missing required fields' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Upsert order
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .upsert({
          order_number: orderData.order_number,
          status: orderData.status,
          currency: orderData.currency || 'EUR',
          totals: orderData.totals,
          customer: orderData.customer,
          billing: orderData.billing,
          shipping: orderData.shipping,
          paid_at: orderData.paid_at || null,
          created_at: new Date().toISOString(),
        }, { onConflict: 'order_number' })
        .select()
        .single();

      if (orderError) {
        console.error('Order upsert error:', orderError);
        return new Response(JSON.stringify({ error: orderError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Delete existing order lines and insert new ones
      await supabase
        .from('order_lines')
        .delete()
        .eq('order_number', orderData.order_number);

      const orderLines = orderData.lines.map(line => ({
        order_number: orderData.order_number,
        sku: line.sku,
        ean: line.ean || null,
        name: line.name,
        qty: line.qty,
        unit_price: line.unit_price,
        vat_rate: line.vat_rate,
        attributes: line.attributes || {},
      }));

      const { error: linesError } = await supabase
        .from('order_lines')
        .insert(orderLines);

      if (linesError) {
        console.error('Order lines insert error:', linesError);
        return new Response(JSON.stringify({ error: linesError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Create export job
      const { error: jobError } = await supabase
        .from('jobs')
        .insert({
          type: 'EXPORT_ORDER_XML',
          payload: { order_number: orderData.order_number },
          state: 'ready',
          attempts: 0,
        });

      if (jobError) {
        console.error('Job creation error:', jobError);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        order_number: orderData.order_number 
      }), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /orders/:orderNumber
    if (req.method === 'GET' && pathParts.length === 3 && pathParts[1] === 'orders-api') {
      const orderNumber = pathParts[2];

      const { data: order, error: orderError } = await supabase
        .from('orders')
        .select('*')
        .eq('order_number', orderNumber)
        .maybeSingle();

      if (orderError) {
        return new Response(JSON.stringify({ error: orderError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!order) {
        return new Response(JSON.stringify({ error: 'Order not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: lines } = await supabase
        .from('order_lines')
        .select('*')
        .eq('order_number', orderNumber);

      return new Response(JSON.stringify({ ...order, lines }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error in orders-api:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
