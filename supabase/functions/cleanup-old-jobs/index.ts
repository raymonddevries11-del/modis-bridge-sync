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

    // Parse batch size from request (default 500 for speed)
    let batchSize = 500;
    try {
      const body = await req.json();
      batchSize = body.batchSize || 500;
    } catch {
      // Ignore parse errors, use default
    }

    console.log(`Starting job cleanup with batch size: ${batchSize}`);

    // Delete ready jobs directly - smaller batch for reliability
    const { count: deletedReadyCount, error: readyError } = await supabase
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'ready')
      .limit(batchSize);

    if (readyError) {
      console.error('Error deleting ready jobs:', readyError);
      throw readyError;
    }

    const deletedReady = deletedReadyCount || 0;
    console.log(`Deleted ${deletedReady} ready jobs`);

    // Delete processing jobs - smaller batch
    const { count: deletedProcessingCount, error: processingError } = await supabase
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('type', 'SYNC_TO_WOO')
      .eq('state', 'processing')
      .limit(batchSize);

    if (processingError) {
      console.error('Error deleting processing jobs:', processingError);
    }

    const deletedProcessing = deletedProcessingCount || 0;
    console.log(`Deleted ${deletedProcessing} processing jobs`);

    const totalDeleted = deletedReady + deletedProcessing;
    
    // Quick check if more remain (without blocking on count)
    const { data: remainingSample } = await supabase
      .from('jobs')
      .select('id')
      .eq('type', 'SYNC_TO_WOO')
      .in('state', ['ready', 'processing'])
      .limit(1);

    const hasMore = (remainingSample?.length || 0) > 0;

    console.log(`Cleanup complete. Deleted: ${totalDeleted}, Has more: ${hasMore}`);

    return new Response(
      JSON.stringify({
        success: true,
        deleted: totalDeleted,
        deletedReady,
        deletedProcessing,
        hasMore,
        message: hasMore 
          ? `Deleted ${totalDeleted} jobs. Run again to delete more.`
          : `Deleted ${totalDeleted} jobs. Cleanup complete!`,
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
