import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { orderNumber } = await req.json();
    
    if (!orderNumber) {
      return new Response(
        JSON.stringify({ error: 'Missing orderNumber' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Exporting order: ${orderNumber}`);

    // Get order with order lines
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*, order_lines(*)')
      .eq('order_number', orderNumber)
      .single();

    if (orderError || !order) {
      throw new Error(`Order ${orderNumber} not found`);
    }

    // Get SFTP config
    const { data: configData, error: configError } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'sftp')
      .single();

    if (configError || !configData) {
      throw new Error('SFTP configuration not found');
    }

    const sftpConfig = configData.value;
    const privateKey = Deno.env.get('SFTP_PRIVATE_KEY');
    
    if (!privateKey) {
      throw new Error('SFTP_PRIVATE_KEY not configured');
    }

    // Generate timestamp for filename
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `order_${orderNumber}_${timestamp}.xml`;

    // Build XML manually
    const customer = order.customer as any;
    const billing = order.billing as any;
    const shipping = order.shipping as any;
    const totals = order.totals as any;
    
    const escapeXml = (str: string) => {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };

    let xmlContent = '<?xml version="1.0" encoding="utf-8"?>\n';
    xmlContent += '<orders>\n';
    xmlContent += '  <envelop>\n';
    xmlContent += `    <bron>woocommerce</bron>\n`;
    xmlContent += `    <bestand>${escapeXml(filename)}</bestand>\n`;
    xmlContent += `    <aangemaakt>${now.toISOString()}</aangemaakt>\n`;
    xmlContent += `    <valuta>${escapeXml(order.currency || 'EUR')}</valuta>\n`;
    xmlContent += '  </envelop>\n';
    xmlContent += '  <order>\n';
    xmlContent += `    <ordernummer>${escapeXml(orderNumber)}</ordernummer>\n`;
    xmlContent += `    <status>${escapeXml(order.status)}</status>\n`;
    xmlContent += `    <betaald-op>${escapeXml(order.paid_at || '')}</betaald-op>\n`;

    // Customer info
    if (customer) {
      xmlContent += '    <klant>\n';
      xmlContent += `      <naam>${escapeXml(customer.name || '')}</naam>\n`;
      xmlContent += `      <email>${escapeXml(customer.email || '')}</email>\n`;
      xmlContent += `      <telefoon>${escapeXml(customer.phone || '')}</telefoon>\n`;
      xmlContent += '    </klant>\n';
    }

    // Billing address
    if (billing) {
      xmlContent += '    <factuuradres>\n';
      xmlContent += `      <regel1>${escapeXml(billing.address1 || '')}</regel1>\n`;
      xmlContent += `      <regel2>${escapeXml(billing.address2 || '')}</regel2>\n`;
      xmlContent += `      <postcode>${escapeXml(billing.postcode || '')}</postcode>\n`;
      xmlContent += `      <plaats>${escapeXml(billing.city || '')}</plaats>\n`;
      xmlContent += `      <land>${escapeXml(billing.country || '')}</land>\n`;
      xmlContent += '    </factuuradres>\n';
    }

    // Shipping address
    if (shipping) {
      xmlContent += '    <verzendadres>\n';
      xmlContent += `      <regel1>${escapeXml(shipping.address1 || '')}</regel1>\n`;
      xmlContent += `      <regel2>${escapeXml(shipping.address2 || '')}</regel2>\n`;
      xmlContent += `      <postcode>${escapeXml(shipping.postcode || '')}</postcode>\n`;
      xmlContent += `      <plaats>${escapeXml(shipping.city || '')}</plaats>\n`;
      xmlContent += `      <land>${escapeXml(shipping.country || '')}</land>\n`;
      xmlContent += '    </verzendadres>\n';
    }

    // Order lines
    xmlContent += '    <regels>\n';
    for (const line of (order.order_lines || [])) {
      xmlContent += '      <regel>\n';
      xmlContent += `        <sku>${escapeXml(line.sku || '')}</sku>\n`;
      xmlContent += `        <ean>${escapeXml(line.ean || '')}</ean>\n`;
      xmlContent += `        <naam>${escapeXml(line.name || '')}</naam>\n`;
      xmlContent += `        <aantal>${line.qty}</aantal>\n`;
      xmlContent += `        <stukprijs>${line.unit_price}</stukprijs>\n`;
      xmlContent += `        <btw-percentage>${line.vat_rate}</btw-percentage>\n`;
      
      const attributes = line.attributes as any;
      if (attributes && typeof attributes === 'object') {
        for (const [key, value] of Object.entries(attributes)) {
          xmlContent += `        <attribuut naam="${escapeXml(key)}">${escapeXml(String(value))}</attribuut>\n`;
        }
      }
      
      xmlContent += '      </regel>\n';
    }
    xmlContent += '    </regels>\n';

    // Totals
    if (totals) {
      xmlContent += '    <totalen>\n';
      xmlContent += `      <items>${totals.items || 0}</items>\n`;
      xmlContent += `      <korting>${totals.discount || 0}</korting>\n`;
      xmlContent += `      <verzending>${totals.shipping || 0}</verzending>\n`;
      xmlContent += `      <btw>${totals.tax || 0}</btw>\n`;
      xmlContent += `      <totaal>${totals.total || 0}</totaal>\n`;
      xmlContent += '    </totalen>\n';
    }

    // Notes
    if ((order as any).notes) {
      xmlContent += `    <opmerkingen>${escapeXml((order as any).notes)}</opmerkingen>\n`;
    }

    xmlContent += '  </order>\n';
    xmlContent += '</orders>';

    // TODO: Implement order export via GitHub Actions or alternative method
    // For now, just log the XML content
    console.log('Order XML generated:', filename);
    console.log('XML length:', xmlContent.length);

    // Store in a temporary location or return to caller
    // This can be enhanced to use Supabase Storage or send via webhook

    console.log(`Order ${orderNumber} XML generated successfully`);

    return new Response(
      JSON.stringify({
        success: true,
        filename: filename,
        orderNumber: orderNumber,
        xmlContent: xmlContent,
        message: 'Order export prepared (SFTP upload via GitHub Actions pending)',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in export-orders:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
