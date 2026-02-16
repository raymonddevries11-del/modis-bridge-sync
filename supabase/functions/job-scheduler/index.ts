import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// ── Configurable retry policy ──────────────────────────────────
// Override via the `config` table (key = "job_retry_policy", value = JSON)
interface RetryPolicy {
  maxAttempts: number;       // total attempts before permanent failure (default 5)
  baseDelaySec: number;      // base delay in seconds for backoff (default 30)
  maxDelaySec: number;       // cap on backoff delay (default 600 = 10 min)
  stuckTimeoutMin: number;   // minutes before a "processing" job is considered stuck (default 15)
}

const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelaySec: 30,
  maxDelaySec: 600,
  stuckTimeoutMin: 15,
};

async function loadRetryPolicy(supabase: any): Promise<RetryPolicy> {
  try {
    const { data } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'job_retry_policy')
      .maybeSingle();
    if (data?.value) {
      return { ...DEFAULT_POLICY, ...(data.value as Partial<RetryPolicy>) };
    }
  } catch (e) {
    console.warn('Could not load retry policy from config, using defaults', e);
  }
  return DEFAULT_POLICY;
}

/** Exponential backoff: baseDelay * 2^(attempt-1), capped at maxDelay */
function backoffMs(attempt: number, policy: RetryPolicy): number {
  const delaySec = Math.min(
    policy.baseDelaySec * Math.pow(2, attempt - 1),
    policy.maxDelaySec,
  );
  return delaySec * 1000;
}

/** Write a changelog alert for a permanently failed job */
async function alertPermanentFailure(supabase: any, job: any, errorMsg: string) {
  try {
    await supabase.from('changelog').insert({
      tenant_id: job.tenant_id,
      event_type: 'JOB_FAILED_PERMANENT',
      description: `Job ${job.type} definitief mislukt na ${job.attempts} pogingen`,
      metadata: {
        jobId: job.id,
        jobType: job.type,
        attempts: job.attempts,
        error: errorMsg,
        productIds: job.payload?.productIds?.slice(0, 10), // first 10 for context
      },
    });
    console.log(`⚠️ ALERT: Permanent failure logged for job ${job.id}`);
  } catch (e) {
    console.error('Failed to write failure alert:', e);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    console.log('Starting job scheduler...');

    const policy = await loadRetryPolicy(supabase);
    console.log(`Retry policy: maxAttempts=${policy.maxAttempts}, baseDelay=${policy.baseDelaySec}s, stuckTimeout=${policy.stuckTimeoutMin}min`);

    // ── 1. Handle stuck jobs ────────────────────────────────────
    const stuckCutoff = new Date(Date.now() - policy.stuckTimeoutMin * 60 * 1000).toISOString();
    const { data: stuckJobs } = await supabase
      .from('jobs')
      .select('id, type, attempts, tenant_id, payload')
      .eq('state', 'processing')
      .lt('updated_at', stuckCutoff);

    if (stuckJobs && stuckJobs.length > 0) {
      console.log(`Found ${stuckJobs.length} stuck jobs`);
      for (const stuckJob of stuckJobs) {
        const attempts = stuckJob.attempts || 0;
        if (attempts >= policy.maxAttempts) {
          await supabase
            .from('jobs')
            .update({
              state: 'error',
              error: `Failed after ${attempts} attempts (stuck in processing)`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', stuckJob.id);
          await alertPermanentFailure(supabase, stuckJob, `Stuck in processing after ${attempts} attempts`);
        } else {
          // Schedule retry with backoff — set updated_at into the future
          const nextRetryAt = new Date(Date.now() + backoffMs(attempts, policy)).toISOString();
          await supabase
            .from('jobs')
            .update({
              state: 'ready',
              error: `Reset from stuck (attempt ${attempts}/${policy.maxAttempts}), next retry after backoff`,
              updated_at: nextRetryAt,
            })
            .eq('id', stuckJob.id);
          console.log(`Job ${stuckJob.id} reset to ready with backoff (attempt ${attempts}/${policy.maxAttempts})`);
        }
      }
    }

    // ── 2. Fetch ready jobs (skip those in backoff) ─────────────
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*')
      .eq('state', 'ready')
      .lte('updated_at', new Date().toISOString()) // skip jobs still in backoff
      .order('created_at', { ascending: true })
      .limit(5);

    if (jobsError) throw jobsError;

    if (!jobs || jobs.length === 0) {
      console.log('No jobs to process');
      return new Response(
        JSON.stringify({ success: true, processed: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing ${jobs.length} jobs sequentially`);

    let processedCount = 0;
    let errorCount = 0;

    for (const job of jobs) {
      try {
        // Mark as processing
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

        // Resolve function name
        let functionName: string;
        switch (job.type) {
          case 'IMPORT_ARTICLES_XML': functionName = 'process-articles'; break;
          case 'EXPORT_ORDER_XML': functionName = 'export-orders'; break;
          case 'SYNC_TO_WOO':
          case 'CREATE_NEW_PRODUCTS':
          case 'UPDATE_PRODUCTS': functionName = 'woocommerce-sync'; break;
          case 'FIX_URL_KEYS':
          case 'DRY_RUN_FIX_URL_KEYS': functionName = 'fix-url-keys'; break;
          case 'SYNC_WOO_SLUGS': functionName = 'sync-woo-slugs'; break;
          default: throw new Error(`Unknown job type: ${job.type}`);
        }

        console.log(`Invoking ${functionName} for job ${job.id} (attempt ${(job.attempts || 0) + 1}/${policy.maxAttempts})`);

        const response = await fetch(
          `${SUPABASE_URL}/functions/v1/${functionName}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ jobId: job.id, ...job.payload }),
          }
        );

        const responseText = await response.text();
        let result;
        try {
          result = responseText ? JSON.parse(responseText) : {};
        } catch {
          throw new Error(`Invalid JSON response: ${responseText.substring(0, 200)}`);
        }

        if (!response.ok) {
          throw new Error(result.error || `Function failed with status ${response.status}`);
        }

        // Success
        await supabase
          .from('jobs')
          .update({ state: 'done', updated_at: new Date().toISOString() })
          .eq('id', job.id);

        console.log(`Job ${job.id} completed successfully`);
        processedCount++;

        // Throttle between jobs
        if (jobs.indexOf(job) < jobs.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

      } catch (error: any) {
        console.error(`Error processing job ${job.id}:`, error);

        const attempts = (job.attempts || 0) + 1;

        if (attempts >= policy.maxAttempts) {
          // ── Permanent failure ──
          await supabase
            .from('jobs')
            .update({ state: 'error', error: error.message, updated_at: new Date().toISOString() })
            .eq('id', job.id);

          await alertPermanentFailure(supabase, { ...job, attempts }, error.message);
          console.log(`Job ${job.id} permanently failed after ${attempts} attempts`);
          errorCount++;
        } else {
          // ── Retry with exponential backoff ──
          const delay = backoffMs(attempts, policy);
          const nextRetryAt = new Date(Date.now() + delay).toISOString();
          await supabase
            .from('jobs')
            .update({
              state: 'ready',
              error: `Attempt ${attempts}/${policy.maxAttempts} failed: ${error.message}. Retry after ${Math.round(delay / 1000)}s backoff.`,
              updated_at: nextRetryAt,
            })
            .eq('id', job.id);

          console.log(`Job ${job.id} scheduled for retry in ${Math.round(delay / 1000)}s (attempt ${attempts}/${policy.maxAttempts})`);
        }
      }
    }

    console.log(`Job scheduler complete. Processed: ${processedCount}, Errors: ${errorCount}`);

    return new Response(
      JSON.stringify({ success: true, processed: processedCount, errors: errorCount }),
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
