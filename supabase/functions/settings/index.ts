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
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const endpoint = pathParts[pathParts.length - 1]; // Get last part (e.g., 'woocommerce' or 'sftp')

    console.log(`Settings endpoint: ${endpoint}, method: ${req.method}`);

    // GET requests - retrieve config
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('config')
        .select('value')
        .eq('key', endpoint)
        .maybeSingle();

      if (error) {
        console.error('Error fetching config:', error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify(data?.value || null),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // POST requests - save config
    if (req.method === 'POST') {
      const body = await req.json();
      
      // Mask sensitive data for logging
      const maskedBody = { ...body };
      if (maskedBody.consumerSecret) maskedBody.consumerSecret = '***';
      console.log('Saving config:', endpoint, maskedBody);

      const { error } = await supabase
        .from('config')
        .upsert({
          key: endpoint,
          value: body,
          updated_at: new Date().toISOString(),
        });

      if (error) {
        console.error('Error saving config:', error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // DELETE requests - remove config
    if (req.method === 'DELETE') {
      const { error } = await supabase
        .from('config')
        .delete()
        .eq('key', endpoint);

      if (error) {
        console.error('Error deleting config:', error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in settings endpoint:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});