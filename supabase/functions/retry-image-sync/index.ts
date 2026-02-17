// Retry failed image syncs with exponential backoff
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 60_000; // 1 minute base

function nextRetryAt(retryCount: number): string {
  // Exponential backoff: 1m, 2m, 4m, 8m, 16m
  const delayMs = BASE_DELAY_MS * Math.pow(2, retryCount);
  return new Date(Date.now() + delayMs).toISOString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json().catch(() => ({}));
    const tenantId = body.tenantId;
    const batchSize = Math.min(body.batchSize || 20, 50);
    const forceAll = body.forceAll === true; // retry all failed, ignoring next_retry_at

    if (!tenantId) {
      return new Response(JSON.stringify({ error: 'tenantId is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch failed items eligible for retry
    let query = supabase
      .from('image_sync_status')
      .select('id, product_id, tenant_id, retry_count, error_message, image_count')
      .eq('tenant_id', tenantId)
      .eq('status', 'failed')
      .lt('retry_count', MAX_RETRIES)
      .order('updated_at', { ascending: true })
      .limit(batchSize);

    if (!forceAll) {
      // Only pick items whose backoff window has elapsed
      query = query.or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`);
    }

    const { data: failedItems, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;

    if (!failedItems || failedItems.length === 0) {
      return new Response(JSON.stringify({ message: 'No eligible items for retry', retried: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Retrying ${failedItems.length} failed image syncs for tenant ${tenantId}`);

    let requeued = 0;
    let exhausted = 0;

    for (const item of failedItems) {
      const newRetryCount = item.retry_count + 1;

      if (newRetryCount >= MAX_RETRIES) {
        // Mark as permanently failed
        await supabase
          .from('image_sync_status')
          .update({
            retry_count: newRetryCount,
            error_message: `Permanent failure after ${MAX_RETRIES} retries. Last: ${item.error_message || 'unknown'}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);
        exhausted++;
        continue;
      }

      // Reset to pending so the push pipeline picks it up again
      await supabase
        .from('image_sync_status')
        .update({
          status: 'pending',
          retry_count: newRetryCount,
          next_retry_at: nextRetryAt(newRetryCount),
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      // Re-queue in pending_product_syncs so batch-woo-sync picks it up
      await supabase
        .from('pending_product_syncs')
        .upsert(
          { product_id: item.product_id, tenant_id: item.tenant_id, reason: 'images', created_at: new Date().toISOString() },
          { onConflict: 'product_id,reason' }
        );

      requeued++;
    }

    // Log to changelog
    if (requeued > 0 || exhausted > 0) {
      await supabase.from('changelog').insert({
        tenant_id: tenantId,
        event_type: 'IMAGE_RETRY_BATCH',
        description: `Image retry batch: ${requeued} opnieuw ingepland, ${exhausted} definitief mislukt`,
        metadata: { requeued, exhausted, batch_size: failedItems.length },
      });
    }

    console.log(`Retry complete: ${requeued} requeued, ${exhausted} exhausted`);

    return new Response(
      JSON.stringify({ retried: requeued, exhausted, total: failedItems.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Retry image sync error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
