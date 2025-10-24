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

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  try {
    // POST /settings/sftp
    if (req.method === 'POST' && pathParts[2] === 'sftp') {
      const body = await req.json();
      
      const { error } = await supabase
        .from('config')
        .upsert({
          key: 'sftp',
          value: {
            host: body.host,
            port: body.port,
            username: body.username,
            privateKeyPath: body.privateKeyPath,
            inboundPath: body.inboundPath,
            outboundPath: body.outboundPath,
          },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'key' });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /settings/woocommerce
    if (req.method === 'POST' && pathParts[2] === 'woocommerce') {
      const body = await req.json();
      
      const { error } = await supabase
        .from('config')
        .upsert({
          key: 'woocommerce',
          value: {
            url: body.url,
            consumerKey: body.consumerKey,
            consumerSecret: body.consumerSecret,
          },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'key' });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /settings/:key
    if (req.method === 'GET' && pathParts.length === 3) {
      const key = pathParts[2];
      
      const { data, error } = await supabase
        .from('config')
        .select('value')
        .eq('key', key)
        .maybeSingle();

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!data) {
        return new Response(JSON.stringify({ value: null }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Mask sensitive data
      let maskedValue = { ...data.value };
      if (key === 'sftp' && maskedValue.privateKeyPath) {
        maskedValue.privateKeyPath = '***';
      }
      if (key === 'woocommerce') {
        if (maskedValue.consumerKey) maskedValue.consumerKey = maskedValue.consumerKey.substring(0, 8) + '***';
        if (maskedValue.consumerSecret) maskedValue.consumerSecret = '***';
      }

      return new Response(JSON.stringify({ value: maskedValue }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error in settings:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
