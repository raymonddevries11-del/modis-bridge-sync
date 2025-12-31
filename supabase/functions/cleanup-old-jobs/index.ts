import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('Starting job cleanup...');

    // Count jobs before deletion
    const { count: readyCount } = await supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'ready');

    const { count: processingCount } = await supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'processing');

    console.log(`Found jobs - ready: ${readyCount}, processing: ${processingCount}`);

    // Use direct delete without fetching IDs first - much faster
    let deletedReady = 0;
    let deletedProcessing = 0;

    // Delete ready jobs in batches using a simple approach
    // We'll delete up to 5000 per invocation to avoid timeout
    const MAX_DELETE_PER_RUN = 5000;
    
    // Delete ready jobs directly
    const { count: deletedReadyCount, error: readyError } = await supabase
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'ready')
      .limit(MAX_DELETE_PER_RUN);

    if (readyError) {
      console.error('Error deleting ready jobs:', readyError);
    } else {
      deletedReady = deletedReadyCount || 0;
      console.log(`Deleted ${deletedReady} ready jobs`);
    }

    // Delete processing jobs
    const { count: deletedProcessingCount, error: processingError } = await supabase
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'processing')
      .limit(1000);

    if (processingError) {
      console.error('Error deleting processing jobs:', processingError);
    } else {
      deletedProcessing = deletedProcessingCount || 0;
      console.log(`Deleted ${deletedProcessing} processing jobs`);
    }

    // Delete old error jobs (older than 7 days)
    let deletedErrors = 0;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const { count: deletedErrorCount, error: errorError } = await supabase
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'error')
      .lt('created_at', sevenDaysAgo)
      .limit(1000);

    if (errorError) {
      console.error('Error deleting error jobs:', errorError);
    } else {
      deletedErrors = deletedErrorCount || 0;
      console.log(`Deleted ${deletedErrors} old error jobs`);
    }

    const totalDeleted = deletedReady + deletedProcessing + deletedErrors;
    
    // Get remaining count
    const { count: remainingReady } = await supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'ready');

    console.log(`Job cleanup complete. Deleted: ${totalDeleted}, Remaining ready: ${remainingReady}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cleaned up ${totalDeleted} jobs`,
        details: {
          readyJobsBefore: readyCount,
          processingJobsBefore: processingCount,
          deletedReady,
          deletedProcessing,
          deletedErrors,
          totalDeleted,
          remainingReady,
          needsMoreRuns: (remainingReady || 0) > 0,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Cleanup error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
