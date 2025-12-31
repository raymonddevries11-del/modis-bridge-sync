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

    const { count: errorCount } = await supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'error');

    console.log(`Found jobs - ready: ${readyCount}, processing: ${processingCount}, error: ${errorCount}`);

    // Delete all ready and processing SYNC_TO_WOO jobs in batches
    let deletedTotal = 0;
    const BATCH_SIZE = 100; // Smaller batch to avoid Bad Request errors

    // Delete ready jobs
    let batchCount = 0;
    while (batchCount < 500) { // Max 500 batches to prevent infinite loops
      const { data: jobsToDelete, error: fetchError } = await supabase
        .from('jobs')
        .select('id')
        .eq('type', 'SYNC_TO_WOO')
        .eq('state', 'ready')
        .limit(BATCH_SIZE);

      if (fetchError) {
        console.error('Error fetching jobs:', fetchError);
        break;
      }

      if (!jobsToDelete || jobsToDelete.length === 0) {
        console.log('No more ready jobs to delete');
        break;
      }

      // Delete one by one for reliability
      let batchDeleted = 0;
      for (const job of jobsToDelete) {
        const { error: deleteError } = await supabase
          .from('jobs')
          .delete()
          .eq('id', job.id);

        if (!deleteError) {
          batchDeleted++;
        }
      }

      deletedTotal += batchDeleted;
      batchCount++;
      console.log(`Batch ${batchCount}: Deleted ${batchDeleted} ready jobs, total: ${deletedTotal}`);
    }

    // Delete processing jobs
    batchCount = 0;
    while (batchCount < 50) {
      const { data: jobsToDelete, error: fetchError } = await supabase
        .from('jobs')
        .select('id')
        .eq('type', 'SYNC_TO_WOO')
        .eq('state', 'processing')
        .limit(BATCH_SIZE);

      if (fetchError) {
        console.error('Error fetching processing jobs:', fetchError);
        break;
      }

      if (!jobsToDelete || jobsToDelete.length === 0) {
        console.log('No more processing jobs to delete');
        break;
      }

      let batchDeleted = 0;
      for (const job of jobsToDelete) {
        const { error: deleteError } = await supabase
          .from('jobs')
          .delete()
          .eq('id', job.id);

        if (!deleteError) {
          batchDeleted++;
        }
      }

      deletedTotal += batchDeleted;
      batchCount++;
      console.log(`Batch ${batchCount}: Deleted ${batchDeleted} processing jobs, total: ${deletedTotal}`);
    }

    // Delete error jobs older than 7 days
    let deletedErrors = 0;
    batchCount = 0;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    while (batchCount < 50) {
      const { data: jobsToDelete, error: fetchError } = await supabase
        .from('jobs')
        .select('id')
        .eq('type', 'SYNC_TO_WOO')
        .eq('state', 'error')
        .lt('created_at', sevenDaysAgo)
        .limit(BATCH_SIZE);

      if (fetchError) {
        console.error('Error fetching error jobs:', fetchError);
        break;
      }

      if (!jobsToDelete || jobsToDelete.length === 0) {
        console.log('No more old error jobs to delete');
        break;
      }

      let batchDeleted = 0;
      for (const job of jobsToDelete) {
        const { error: deleteError } = await supabase
          .from('jobs')
          .delete()
          .eq('id', job.id);

        if (!deleteError) {
          batchDeleted++;
        }
      }

      deletedErrors += batchDeleted;
      deletedTotal += batchDeleted;
      batchCount++;
      console.log(`Batch ${batchCount}: Deleted ${batchDeleted} old error jobs, total errors: ${deletedErrors}`);
    }

    console.log(`Job cleanup complete. Total deleted: ${deletedTotal}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cleaned up ${deletedTotal} jobs`,
        details: {
          readyJobsBefore: readyCount,
          processingJobsBefore: processingCount,
          errorJobsBefore: errorCount,
          totalDeleted: deletedTotal,
          oldErrorsDeleted: deletedErrors,
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
