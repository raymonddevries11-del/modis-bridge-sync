import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// EdgeRuntime is available in the runtime; declare for TypeScript.
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function cleanupJobs(batchSize: number) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  console.log(`[cleanup-old-jobs] Running cleanup batchSize=${batchSize}`);

  // Keep it extremely small and simple to avoid DB timeouts.
  const { count: deletedReadyCount, error: readyError } = await supabase
    .from('jobs')
    .delete({ count: 'exact' })
    .eq('type', 'SYNC_TO_WOO')
    .eq('state', 'ready')
    .limit(batchSize);

  if (readyError) {
    console.error('[cleanup-old-jobs] Error deleting ready jobs:', readyError);
    throw readyError;
  }

  const { count: deletedProcessingCount, error: processingError } = await supabase
    .from('jobs')
    .delete({ count: 'exact' })
    .eq('type', 'SYNC_TO_WOO')
    .eq('state', 'processing')
    .limit(batchSize);

  if (processingError) {
    console.error('[cleanup-old-jobs] Error deleting processing jobs:', processingError);
    // Don't throw: even partial cleanup helps.
  }

  const deletedReady = deletedReadyCount || 0;
  const deletedProcessing = deletedProcessingCount || 0;
  console.log(
    `[cleanup-old-jobs] Done. deletedReady=${deletedReady} deletedProcessing=${deletedProcessing}`,
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let batchSize = 50;
    try {
      const body = await req.json();
      const maybe = Number(body?.batchSize);
      if (Number.isFinite(maybe) && maybe > 0) batchSize = Math.min(maybe, 250);
    } catch {
      // ignore
    }

    // Run cleanup in background so the HTTP call returns fast even under load.
    // (This avoids tool/client timeouts while the DB is slow.)
    EdgeRuntime.waitUntil(cleanupJobs(batchSize));

    return new Response(
      JSON.stringify({
        started: true,
        batchSize,
        message: `Cleanup started (batchSize=${batchSize}). Call again to continue deleting.`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[cleanup-old-jobs] Request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
