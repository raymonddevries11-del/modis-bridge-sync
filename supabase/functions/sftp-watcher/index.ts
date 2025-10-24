import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { SftpClient } from "../_shared/sftp-client.ts";

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
    console.log('Starting SFTP file watcher...');

    // Get SFTP config from database
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

    // Connect to SFTP
    const sftpClient = new SftpClient();
    await sftpClient.connect({
      host: sftpConfig.host,
      port: sftpConfig.port,
      username: sftpConfig.username,
      privateKey: privateKey,
    });

    const inboundPath = sftpConfig.inboundPath || '/home/customer/www/developmentplatform.nl/public_html/kosterschoenmode/modis-to-wp';
    const readyPath = `${inboundPath}/ready`;

    // Ensure ready directory exists
    await sftpClient.ensureDir(readyPath);

    // List XML files in ready directory
    const files = await sftpClient.listFiles(readyPath);
    const xmlFiles = files.filter(f => 
      f.name.endsWith('.xml') && 
      !f.name.endsWith('.tmp') && 
      !f.name.endsWith('.part')
    );

    console.log(`Found ${xmlFiles.length} XML files in ${readyPath}`);

    let newJobsCreated = 0;

    // Check each file and create jobs if needed
    for (const file of xmlFiles) {
      // Check if job already exists for this file
      const { data: existingJobs } = await supabase
        .from('jobs')
        .select('id')
        .eq('type', 'IMPORT_ARTICLES_XML')
        .contains('payload', { filename: file.name })
        .in('state', ['ready', 'processing']);

      if (!existingJobs || existingJobs.length === 0) {
        // Create new job
        const { error: jobError } = await supabase
          .from('jobs')
          .insert({
            type: 'IMPORT_ARTICLES_XML',
            state: 'ready',
            payload: {
              filename: file.name,
              sourcePath: readyPath,
            },
          });

        if (jobError) {
          console.error(`Error creating job for ${file.name}:`, jobError);
        } else {
          console.log(`Created job for ${file.name}`);
          newJobsCreated++;
        }
      } else {
        console.log(`Job already exists for ${file.name}, skipping`);
      }
    }

    await sftpClient.disconnect();

    console.log(`SFTP watcher complete. Created ${newJobsCreated} new jobs.`);

    return new Response(
      JSON.stringify({
        success: true,
        filesFound: xmlFiles.length,
        newJobs: newJobsCreated,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in sftp-watcher:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
