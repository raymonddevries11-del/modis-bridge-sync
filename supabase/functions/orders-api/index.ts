import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// Constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyApiKey(supabase: any, authHeader: string | null): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const providedKey = authHeader.substring(7);
  
  // Hash the provided key
  const encoder = new TextEncoder();
  const data = encoder.encode(providedKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const providedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  const { data: apiKeys } = await supabase
    .from('api_keys')
    .select('id, key_hash');

  if (!apiKeys || apiKeys.length === 0) {
    return false;
  }

  // Use constant-time comparison
  let validKey = null;
  for (const key of apiKeys) {
    if (timingSafeEqual(providedHash, key.key_hash)) {
      validKey = key;
      break;
    }
  }

  if (!validKey) {
    return false;
  }

  // Update last_used_at
  await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', validKey.id);

  return true;
}

// Input validation functions
function validateOrderNumber(orderNumber: any): boolean {
  return typeof orderNumber === 'string' && orderNumber.length > 0 && orderNumber.length <= 100;
}

function validateStatus(status: any): boolean {
  const validStatuses = ['pending', 'processing', 'completed', 'cancelled', 'on-hold', 'failed', 'refunded'];
  return typeof status === 'string' && validStatuses.includes(status.toLowerCase());
}

function validateEmail(email: any): boolean {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

function sanitizeString(str: string, maxLength: number = 500): string {
  return str.trim().substring(0, maxLength);
}

function validateOrderData(orderData: any): { valid: boolean; error?: string } {
  if (!validateOrderNumber(orderData.order_number)) {
    return { valid: false, error: 'Invalid order number' };
  }

  if (!validateStatus(orderData.status)) {
    return { valid: false, error: 'Invalid order status' };
  }

  if (orderData.customer?.email && !validateEmail(orderData.customer.email)) {
    return { valid: false, error: 'Invalid customer email' };
  }

  if (!Array.isArray(orderData.lines) || orderData.lines.length === 0) {
    return { valid: false, error: 'Order must have at least one line item' };
  }

  // Validate each line
  for (const line of orderData.lines) {
    if (!line.sku || typeof line.sku !== 'string' || line.sku.length > 100) {
      return { valid: false, error: 'Invalid SKU in order line' };
    }
    if (!line.name || typeof line.name !== 'string' || line.name.length > 500) {
      return { valid: false, error: 'Invalid product name in order line' };
    }
    if (typeof line.qty !== 'number' || line.qty <= 0 || line.qty > 10000) {
      return { valid: false, error: 'Invalid quantity in order line' };
    }
    if (typeof line.unit_price !== 'number' || line.unit_price < 0) {
      return { valid: false, error: 'Invalid unit price in order line' };
    }
    if (typeof line.vat_rate !== 'number' || line.vat_rate < 0 || line.vat_rate > 100) {
      return { valid: false, error: 'Invalid VAT rate in order line' };
    }
  }

  return { valid: true };
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

      // Validate input
      const validation = validateOrderData(orderData);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Sanitize string inputs
      const sanitizedCustomer = orderData.customer ? {
        ...orderData.customer,
        name: sanitizeString(orderData.customer.name || '', 200),
        email: sanitizeString(orderData.customer.email || '', 255),
      } : {};

      // Upsert order
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .upsert({
          order_number: sanitizeString(orderData.order_number, 100),
          status: orderData.status.toLowerCase(),
          currency: orderData.currency || 'EUR',
          totals: orderData.totals,
          customer: sanitizedCustomer,
          billing: orderData.billing,
          shipping: orderData.shipping,
          paid_at: orderData.paid_at || null,
          created_at: new Date().toISOString(),
        }, { onConflict: 'order_number' })
        .select()
        .single();

      if (orderError) {
        console.error('Order upsert failed');
        return new Response(JSON.stringify({ error: 'Unable to process order' }), {
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
        sku: sanitizeString(line.sku, 100),
        ean: line.ean ? sanitizeString(line.ean, 50) : null,
        name: sanitizeString(line.name, 500),
        qty: line.qty,
        unit_price: line.unit_price,
        vat_rate: line.vat_rate,
        attributes: line.attributes || {},
      }));

      const { error: linesError } = await supabase
        .from('order_lines')
        .insert(orderLines);

      if (linesError) {
        console.error('Order lines insert failed');
        return new Response(JSON.stringify({ error: 'Unable to process order lines' }), {
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
        console.error('Job creation failed');
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
      const authHeader = req.headers.get('authorization');
      const isValid = await verifyApiKey(supabase, authHeader);
      
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const orderNumber = pathParts[2];

      const { data: order, error: orderError } = await supabase
        .from('orders')
        .select('*')
        .eq('order_number', orderNumber)
        .maybeSingle();

      if (orderError) {
        return new Response(JSON.stringify({ error: 'Unable to retrieve order' }), {
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
    console.error('Request processing failed');
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
