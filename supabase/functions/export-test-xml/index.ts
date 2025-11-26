import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Simplified test XML with just 2 products
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<artikelen>
  <artikel>
    <artnr>TEST001</artnr>
    <omschrijving>Test Product 1</omschrijving>
    <merk>Test Brand</merk>
    <verkoopprijs>49,99</verkoopprijs>
    <voorraad>10</voorraad>
  </artikel>
  <artikel>
    <artnr>TEST002</artnr>
    <omschrijving>Test Product 2</omschrijving>
    <merk>Test Brand</merk>
    <verkoopprijs>59,99</verkoopprijs>
    <voorraad>5</voorraad>
  </artikel>
</artikelen>`;

    const encoder = new TextEncoder();
    const xmlBytes = encoder.encode(xml);

    return new Response(xmlBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="test-products.xml"',
        'Content-Length': String(xmlBytes.length),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });

  } catch (error: any) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
