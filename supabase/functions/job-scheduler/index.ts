import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    console.log('Starting job scheduler...');

    // First, reset stuck jobs that have been processing for more than 15 minutes
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: stuckJobs } = await supabase
      .from('jobs')
      .select('id, type, attempts')
      .eq('state', 'processing')
      .lt('updated_at', fifteenMinutesAgo);
    
    if (stuckJobs && stuckJobs.length > 0) {
      console.log(`Found ${stuckJobs.length} stuck jobs, resetting to ready`);
      for (const stuckJob of stuckJobs) {
        await supabase
          .from('jobs')
          .update({
            state: 'ready',
            error: `Reset from stuck processing state (attempt ${stuckJob.attempts})`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', stuckJob.id);
      }
    }

    // Get ready jobs - process maximum 3 jobs per run to avoid overwhelming hosting
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*')
      .eq('state', 'ready')
      .order('created_at', { ascending: true })
      .limit(3);

    if (jobsError) {
      throw jobsError;
    }

    if (!jobs || jobs.length === 0) {
      console.log('No jobs to process');
      return new Response(
        JSON.stringify({ success: true, processed: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing ${jobs.length} jobs sequentially to avoid overwhelming hosting`);

    let processedCount = 0;
    let errorCount = 0;

    // Process jobs sequentially instead of parallel to avoid overwhelming hosting
    for (const job of jobs) {
      try {
        // Update job to processing
        const { error: updateError } = await supabase
          .from('jobs')
          .update({
            state: 'processing',
            attempts: (job.attempts || 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)
          .eq('state', 'ready');

        if (updateError) {
          console.error(`Error updating job ${job.id}:`, updateError);
          continue;
        }

        // Process based on job type
        let functionName: string;
        switch (job.type) {
          case 'IMPORT_ARTICLES_XML':
            functionName = 'process-articles';
            break;
          case 'EXPORT_ORDER_XML':
            functionName = 'export-orders';
            break;
          case 'SYNC_TO_WOO':
            functionName = 'woocommerce-sync';
            break;
          default:
            throw new Error(`Unknown job type: ${job.type}`);
        }

        console.log(`Invoking ${functionName} for job ${job.id}`);

        // Invoke the edge function with jobId
        const response = await fetch(
          `${SUPABASE_URL}/functions/v1/${functionName}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
              jobId: job.id,
              ...job.payload
            }),
          }
        );

        const responseText = await response.text();
        let result;
        
        try {
          result = responseText ? JSON.parse(responseText) : {};
        } catch (parseError) {
          console.error('Failed to parse response:', responseText);
          throw new Error(`Invalid JSON response: ${responseText.substring(0, 200)}`);
        }

        if (!response.ok) {
          throw new Error(result.error || `Function invocation failed with status ${response.status}`);
        }

        // Update job to done
        await supabase
          .from('jobs')
          .update({
            state: 'done',
            result: result,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);

        console.log(`Job ${job.id} completed successfully`);
        processedCount++;

        // Add delay between jobs to avoid overwhelming hosting provider
        if (jobs.indexOf(job) < jobs.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        }

      } catch (error: any) {
        console.error(`Error processing job ${job.id}:`, error);
        
        const attempts = (job.attempts || 0) + 1;
        const maxAttempts = 3;

        if (attempts >= maxAttempts) {
          await supabase
            .from('jobs')
            .update({
              state: 'error',
              error: error.message,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id);
          
          console.log(`Job ${job.id} failed after ${attempts} attempts`);
          errorCount++;
        } else {
          await supabase
            .from('jobs')
            .update({
              state: 'ready',
              error: error.message,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id);
          
          console.log(`Job ${job.id} will be retried (attempt ${attempts}/${maxAttempts})`);
        }
      }
    }

    console.log(`Job scheduler complete. Processed: ${processedCount}, Errors: ${errorCount}`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: processedCount,
        errors: errorCount,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in job-scheduler:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
