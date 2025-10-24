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
    // Check database connectivity
    const { error: dbError } = await supabase
      .from('jobs')
      .select('id')
      .limit(1);

    if (dbError) {
      return new Response(JSON.stringify({ 
        status: 'unhealthy',
        database: 'disconnected',
        error: dbError.message 
      }), {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get job queue status
    const { data: jobStats } = await supabase
      .from('jobs')
      .select('state')
      .in('state', ['ready', 'processing', 'error']);

    const queueStatus = {
      ready: 0,
      processing: 0,
      failed: 0,
    };

    jobStats?.forEach(job => {
      if (job.state === 'ready') queueStatus.ready++;
      else if (job.state === 'processing') queueStatus.processing++;
      else if (job.state === 'error') queueStatus.failed++;
    });

    // Get last successful job run
    const { data: lastJob } = await supabase
      .from('jobs')
      .select('updated_at, type')
      .eq('state', 'done')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Get SFTP status from config
    const { data: sftpConfig } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'sftp_last_connection')
      .maybeSingle();

    const sftpLastConnection = sftpConfig?.value?.timestamp || null;

    return new Response(JSON.stringify({
      status: 'healthy',
      database: 'connected',
      queue: queueStatus,
      last_job: lastJob ? {
        type: lastJob.type,
        completed_at: lastJob.updated_at,
      } : null,
      sftp: {
        last_connection: sftpLastConnection,
      },
      timestamp: new Date().toISOString(),
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error in health check:', error);
    return new Response(JSON.stringify({ 
      status: 'unhealthy',
      error: error.message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
