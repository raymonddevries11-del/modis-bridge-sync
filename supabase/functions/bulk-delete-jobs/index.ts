import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let targetBatches = 50; // Number of delete batches to run
    let batchSize = 500;    // Items per batch (smaller to avoid DB overload)
    let jobType = 'SYNC_TO_WOO';
    let targetStates = ['ready', 'processing', 'done', 'error'];
    let delayMs = 500;      // Delay between batches

    try {
      const body = await req.json();
      if (body.batches && Number.isFinite(body.batches)) {
        targetBatches = Math.min(Math.max(body.batches, 1), 50);
      }
      if (body.batchSize && Number.isFinite(body.batchSize)) {
        batchSize = Math.min(Math.max(body.batchSize, 100), 2000);
      }
      if (body.type) {
        jobType = body.type;
      }
      if (body.states && Array.isArray(body.states)) {
        targetStates = body.states;
      }
      if (body.delayMs && Number.isFinite(body.delayMs)) {
        delayMs = Math.min(Math.max(body.delayMs, 100), 2000);
      }
    } catch {
      // Use defaults
    }

    console.log(`[bulk-delete-jobs] Starting: ${targetBatches} batches × ${batchSize} items for type=${jobType}`);

    let totalDeleted = 0;
    const startTime = Date.now();

    for (let i = 0; i < targetBatches; i++) {
      // Fetch IDs to delete
      const { data: jobsToDelete, error: fetchError } = await supabase
        .from('jobs')
        .select('id')
        .eq('type', jobType)
        .in('state', targetStates)
        .limit(batchSize);

      if (fetchError) {
        console.error(`[bulk-delete-jobs] Fetch error batch ${i + 1}:`, fetchError);
        break;
      }

      if (!jobsToDelete || jobsToDelete.length === 0) {
        console.log(`[bulk-delete-jobs] No more jobs to delete at batch ${i + 1}`);
        break;
      }

      const ids = jobsToDelete.map(j => j.id);

      // Delete in smaller chunks to avoid timeouts
      const chunkSize = 200;
      let batchDeleted = 0;

      for (let j = 0; j < ids.length; j += chunkSize) {
        const chunk = ids.slice(j, j + chunkSize);
        const { count, error: deleteError } = await supabase
          .from('jobs')
          .delete({ count: 'exact' })
          .in('id', chunk);

        if (deleteError) {
          console.error(`[bulk-delete-jobs] Delete error:`, deleteError);
        } else {
          batchDeleted += count || 0;
        }
      }

      totalDeleted += batchDeleted;
      console.log(`[bulk-delete-jobs] Batch ${i + 1}/${targetBatches}: deleted ${batchDeleted} jobs`);

      // Delay between batches to prevent DB overload
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const elapsedMs = Date.now() - startTime;

    // Get remaining count
    const { count: remainingCount } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('type', jobType);

    console.log(`[bulk-delete-jobs] Done. Deleted ${totalDeleted} jobs in ${elapsedMs}ms. Remaining: ${remainingCount}`);

    return new Response(
      JSON.stringify({
        success: true,
        deleted: totalDeleted,
        remaining: remainingCount || 0,
        elapsedMs,
        message: `Deleted ${totalDeleted} ${jobType} jobs. ${remainingCount || 0} remaining.`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[bulk-delete-jobs] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
