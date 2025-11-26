import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import SftpClient from 'https://esm.sh/ssh2-sftp-client@10.0.3';

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
    const { filename, content } = await req.json();
    
    if (!filename || !content) {
      return new Response(
        JSON.stringify({ error: 'Missing filename or content' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Uploading ${filename} to SFTP via SSH command...`);

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

    // Get tenant_id from filename pattern (assumes format includes tenant info)
    // For now, we'll use the outboundPath from config as the base
    const basePath = sftpConfig.outboundPath || '';
    const remotePath = basePath ? `${basePath}/${filename}` : filename;

    console.log(`Uploading to remote path: ${remotePath}`);

    // Use ssh2-sftp-client library
    const sftp = new SftpClient();
    
    try {
      // Connect to SFTP server
      await sftp.connect({
        host: sftpConfig.host,
        port: sftpConfig.port || 22,
        username: sftpConfig.username,
        privateKey: privateKey,
      });

      console.log('Connected to SFTP server');

      // Upload the content (convert string to Uint8Array)
      const encoder = new TextEncoder();
      await sftp.put(encoder.encode(content), remotePath);
      
      console.log('File uploaded successfully');
      
      return new Response(
        JSON.stringify({
          success: true,
          filename: filename,
          message: 'File uploaded to SFTP successfully',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } finally {
      // Close SFTP connection
      await sftp.end();
    }

  } catch (error: any) {
    console.error('Error in sftp-upload:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
