import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.76.1";

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

    // Write private key to temp file
    const keyFile = await Deno.makeTempFile();
    await Deno.writeTextFile(keyFile, privateKey);
    await Deno.chmod(keyFile, 0o600);

    // Write content to temp file
    const contentFile = await Deno.makeTempFile();
    await Deno.writeTextFile(contentFile, content);

    try {
      // Use scp command to upload file
      const command = new Deno.Command("scp", {
        args: [
          "-i", keyFile,
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-P", String(sftpConfig.port || 22),
          contentFile,
          `${sftpConfig.username}@${sftpConfig.host}:${remotePath}`
        ],
        stdout: "piped",
        stderr: "piped",
      });

      const process = command.spawn();
      const { code, stdout, stderr } = await process.output();

      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      if (code !== 0) {
        console.error('SCP failed:', stderrText);
        throw new Error(`SCP upload failed: ${stderrText}`);
      }

      console.log('SCP success:', stdoutText);
      
      return new Response(
        JSON.stringify({
          success: true,
          filename: filename,
          message: 'File uploaded to SFTP successfully',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } finally {
      // Clean up temp files
      try {
        await Deno.remove(keyFile);
        await Deno.remove(contentFile);
      } catch (e) {
        console.error('Failed to clean up temp files:', e);
      }
    }

  } catch (error: any) {
    console.error('Error in sftp-upload:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
