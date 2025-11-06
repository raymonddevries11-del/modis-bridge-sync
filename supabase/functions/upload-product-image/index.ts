import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const tenantId = formData.get('tenantId') as string;
    const fileName = formData.get('fileName') as string;

    if (!file || !tenantId || !fileName) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: file, tenantId, fileName' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if file already exists
    const { data: existingFiles } = await supabase.storage
      .from('product-images')
      .list(tenantId, {
        search: fileName
      });

    if (existingFiles && existingFiles.length > 0) {
      console.log(`File ${fileName} already exists, skipping upload`);
      return new Response(
        JSON.stringify({ 
          message: 'File already exists',
          path: `${tenantId}/${fileName}`
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Upload the file
    const fileBytes = await file.arrayBuffer();
    const { data, error } = await supabase.storage
      .from('product-images')
      .upload(`${tenantId}/${fileName}`, fileBytes, {
        contentType: file.type || 'image/jpeg',
        upsert: false
      });

    if (error) {
      console.error('Upload error:', error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Successfully uploaded ${fileName} for tenant ${tenantId}`);

    return new Response(
      JSON.stringify({ 
        message: 'Upload successful',
        path: data.path
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Function error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
