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
interface RetryPolicy {
  maxAttempts: number;
  baseDelaySec: number;
  maxDelaySec: number;
  stuckTimeoutMin: number;
}

const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelaySec: 30,
  maxDelaySec: 600,
  stuckTimeoutMin: 15,
};

// ── Auto-scaling config ────────────────────────────────────────
interface ScalingConfig {
  queueAlertThreshold: number;
  scaleBatchSize: number;
  normalBatchSize: number;
  maxChainedInvocations: number;
  graceWindowMin: number;
  concurrency: number;
  interJobDelayMs: number;
  maxJobsPerTenant: number;
}

const DEFAULT_SCALING: ScalingConfig = {
  queueAlertThreshold: 50,
  scaleBatchSize: 15,
  normalBatchSize: 8,
  maxChainedInvocations: 5,
  graceWindowMin: 5,
  concurrency: 3,
  interJobDelayMs: 500,
  maxJobsPerTenant: 2,
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

async function loadScalingConfig(supabase: any): Promise<ScalingConfig> {
  try {
    const { data } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'job_scaling_config')
      .maybeSingle();
    if (data?.value) {
      return { ...DEFAULT_SCALING, ...(data.value as Partial<ScalingConfig>) };
    }
  } catch (e) {
    console.warn('Could not load scaling config, using defaults', e);
  }
  return DEFAULT_SCALING;
}

function backoffMs(attempt: number, policy: RetryPolicy): number {
  const delaySec = Math.min(
    policy.baseDelaySec * Math.pow(2, attempt - 1),
    policy.maxDelaySec,
  );
  return delaySec * 1000;
}

async function alertPermanentFailure(supabase: any, job: any, errorMsg: string) {
  try {
    await supabase.from('changelog').insert({
      tenant_id: job.tenant_id,
      event_type: 'JOB_FAILED_PERMANENT',
      description: `Job ${job.type} definitief mislukt na ${job.attempts} pogingen`,
      metadata: {
        jobId: job.id,
        jobType: job.type,
        scope: job.scope,
        attempts: job.attempts,
        error: errorMsg,
        productIds: job.payload?.productIds?.slice(0, 10),
      },
    });
    console.log(`⚠️ ALERT: Permanent failure logged for job ${job.id}`);
  } catch (e) {
    console.error('Failed to write failure alert:', e);
  }
}

function resolveFunction(type: string): string {
  switch (type) {
    case 'IMPORT_ARTICLES_XML': return 'process-articles';
    case 'EXPORT_ORDER_XML': return 'export-orders';
    case 'SYNC_TO_WOO':
    case 'CREATE_NEW_PRODUCTS':
    case 'UPDATE_PRODUCTS': return 'woocommerce-sync';
    case 'FIX_URL_KEYS':
    case 'DRY_RUN_FIX_URL_KEYS': return 'fix-url-keys';
    case 'SYNC_WOO_SLUGS': return 'sync-woo-slugs';
    case 'SFTP_SCAN': return 'sftp-watcher';
    default: throw new Error(`Unknown job type: ${type}`);
  }
}

// ── Rate limiting helpers ──────────────────────────────────────

async function rateLimitAllow(supabase: any, tenantId: string): Promise<boolean> {
  const { data } = await supabase
    .from('rate_limit_state')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!data) return true; // no rate limit record = allow

  const now = new Date();

  // Check cooldown
  if (data.cooldown_until && new Date(data.cooldown_until) > now) {
    console.log(`Tenant ${tenantId} in cooldown until ${data.cooldown_until}`);
    return false;
  }

  // Refill tokens
  const lastRefill = new Date(data.last_refill_at);
  const elapsedMin = (now.getTime() - lastRefill.getTime()) / 60000;
  const effectiveRefillRate = data.refill_per_minute * data.penalty_factor;
  const tokensToAdd = Math.floor(elapsedMin * effectiveRefillRate);
  const newTokens = Math.min(data.capacity, (data.tokens || 0) + tokensToAdd);

  if (newTokens <= 0) {
    return false;
  }

  // Decrement token
  await supabase
    .from('rate_limit_state')
    .update({
      tokens: newTokens - 1,
      last_refill_at: tokensToAdd > 0 ? now.toISOString() : data.last_refill_at,
      updated_at: now.toISOString(),
    })
    .eq('tenant_id', tenantId);

  return true;
}

async function rateLimitPenalize(supabase: any, tenantId: string) {
  const { data } = await supabase
    .from('rate_limit_state')
    .select('penalty_factor')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  const currentPenalty = data?.penalty_factor || 1.0;
  const newPenalty = Math.max(currentPenalty * 0.5, 0.1); // halve the effective rate
  const cooldownUntil = new Date(Date.now() + 30000).toISOString(); // 30s cooldown

  await supabase
    .from('rate_limit_state')
    .upsert({
      tenant_id: tenantId,
      penalty_factor: newPenalty,
      cooldown_until: cooldownUntil,
      tokens: 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id' });

  console.log(`⚠️ Rate limit penalized tenant ${tenantId}: penalty=${newPenalty}, cooldown=30s`);
}

async function rateLimitSuccess(supabase: any, tenantId: string) {
  const { data } = await supabase
    .from('rate_limit_state')
    .select('penalty_factor')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!data || data.penalty_factor >= 1.0) return;

  // Gradually restore: multiply by 1.1 towards 1.0
  const newPenalty = Math.min(data.penalty_factor * 1.1, 1.0);

  await supabase
    .from('rate_limit_state')
    .update({
      penalty_factor: newPenalty,
      cooldown_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);
}

/** Check queue health and update alert state with grace period */
async function checkQueueHealth(supabase: any, queueSize: number, scaling: ScalingConfig) {
  const alertKey = 'job_queue_health';
  try {
    const { data: existing } = await supabase
      .from('config')
      .select('value')
      .eq('key', alertKey)
      .maybeSingle();

    const now = new Date();
    const currentState = existing?.value as any || {};

    if (queueSize >= scaling.queueAlertThreshold) {
      const graceStartedAt = currentState.grace_started_at
        ? new Date(currentState.grace_started_at)
        : null;

      if (!graceStartedAt) {
        await supabase.from('config').upsert({
          key: alertKey,
          value: {
            alert_active: false,
            grace_started_at: now.toISOString(),
            queue_size: queueSize,
            threshold: scaling.queueAlertThreshold,
            scaled_batch_size: scaling.scaleBatchSize,
          },
          updated_at: now.toISOString(),
        }, { onConflict: 'key' });
      } else {
        const graceElapsedMin = (now.getTime() - graceStartedAt.getTime()) / 60000;
        if (graceElapsedMin >= scaling.graceWindowMin && !currentState.alert_active) {
          await supabase.from('config').upsert({
            key: alertKey,
            value: {
              alert_active: true,
              grace_started_at: currentState.grace_started_at,
              alerted_at: now.toISOString(),
              queue_size: queueSize,
              threshold: scaling.queueAlertThreshold,
              scaled_batch_size: scaling.scaleBatchSize,
            },
            updated_at: now.toISOString(),
          }, { onConflict: 'key' });
          console.log(`🚨 Queue alert activated — ${queueSize} jobs`);
        }
      }
    } else if (currentState.alert_active || currentState.grace_started_at) {
      await supabase.from('config').upsert({
        key: alertKey,
        value: {
          alert_active: false,
          grace_started_at: null,
          alerted_at: null,
          cleared_at: now.toISOString(),
          queue_size: queueSize,
          threshold: scaling.queueAlertThreshold,
        },
        updated_at: now.toISOString(),
      }, { onConflict: 'key' });
    }
  } catch (e) {
    console.error('Failed to update queue health:', e);
  }
}

/** Execute a single job — returns true on success */
async function executeJob(
  supabase: any,
  job: any,
  policy: RetryPolicy,
): Promise<boolean> {
  try {
    // Rate limit check per tenant
    if (job.tenant_id) {
      const allowed = await rateLimitAllow(supabase, job.tenant_id);
      if (!allowed) {
        // Reschedule job with small delay
        const nextRun = new Date(Date.now() + 15000).toISOString();
        await supabase.from('jobs')
          .update({ next_run_at: nextRun, updated_at: new Date().toISOString() })
          .eq('id', job.id);
        console.log(`⏸ Job ${job.id} deferred — tenant rate limited`);
        return false;
      }
    }

    // Claim the job
    const { error: claimErr } = await supabase
      .from('jobs')
      .update({
        state: 'processing',
        attempts: (job.attempts || 0) + 1,
        locked_at: new Date().toISOString(),
        locked_by: 'job-scheduler',
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('state', 'ready');

    if (claimErr) {
      console.error(`Failed to claim job ${job.id}:`, claimErr);
      return false;
    }

    const functionName = resolveFunction(job.type);
    const attempts = (job.attempts || 0) + 1;
    console.log(`→ ${functionName} for ${job.id} (scope=${job.scope || 'FULL'}, attempt ${attempts}/${policy.maxAttempts})`);

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
      // Check for rate limiting from WooCommerce
      if (response.status === 429 || response.status === 503) {
        if (job.tenant_id) {
          await rateLimitPenalize(supabase, job.tenant_id);
        }
      }
      throw new Error(result.error || `Function failed with status ${response.status}`);
    }

    // Success — update rate limit recovery
    if (job.tenant_id) {
      await rateLimitSuccess(supabase, job.tenant_id);
    }

    await supabase.from('jobs')
      .update({
        state: 'done',
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    console.log(`✓ Job ${job.id} done`);
    return true;
  } catch (error: any) {
    console.error(`✗ Job ${job.id}:`, error.message);
    const attempts = (job.attempts || 0) + 1;

    if (attempts >= policy.maxAttempts) {
      await supabase.from('jobs')
        .update({
          state: 'error',
          error: error.message,
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
      await alertPermanentFailure(supabase, { ...job, attempts }, error.message);
    } else {
      const delay = backoffMs(attempts, policy);
      const nextRetryAt = new Date(Date.now() + delay).toISOString();
      await supabase.from('jobs')
        .update({
          state: 'ready',
          error: `Attempt ${attempts}/${policy.maxAttempts}: ${error.message}. Retry after ${Math.round(delay / 1000)}s.`,
          next_run_at: nextRetryAt,
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    }
    return false;
  }
}

/** Process a batch of jobs with tenant fairness and priority ordering */
async function processBatch(
  supabase: any,
  policy: RetryPolicy,
  batchSize: number,
  concurrency: number,
  interJobDelayMs: number,
  maxJobsPerTenant: number,
): Promise<{ processed: number; errors: number; remaining: number }> {
  // Handle stuck jobs
  const stuckCutoff = new Date(Date.now() - policy.stuckTimeoutMin * 60 * 1000).toISOString();
  const { data: stuckJobs } = await supabase
    .from('jobs')
    .select('id, type, attempts, tenant_id, payload, scope')
    .eq('state', 'processing')
    .lt('updated_at', stuckCutoff);

  if (stuckJobs && stuckJobs.length > 0) {
    console.log(`Found ${stuckJobs.length} stuck jobs`);
    for (const stuckJob of stuckJobs) {
      const attempts = stuckJob.attempts || 0;
      if (attempts >= policy.maxAttempts) {
        await supabase.from('jobs').update({
          state: 'error',
          error: `Failed after ${attempts} attempts (stuck in processing)`,
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        }).eq('id', stuckJob.id);
        await alertPermanentFailure(supabase, stuckJob, `Stuck in processing after ${attempts} attempts`);
      } else {
        const nextRetryAt = new Date(Date.now() + backoffMs(attempts, policy)).toISOString();
        await supabase.from('jobs').update({
          state: 'ready',
          error: `Reset from stuck (attempt ${attempts}/${policy.maxAttempts})`,
          next_run_at: nextRetryAt,
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        }).eq('id', stuckJob.id);
      }
    }
  }

  // Fetch ready jobs ordered by priority DESC, then next_run_at ASC
  const now = new Date().toISOString();
  const { data: jobs, error: jobsError } = await supabase
    .from('jobs')
    .select('*')
    .eq('state', 'ready')
    .lte('next_run_at', now)
    .order('priority', { ascending: false })
    .order('next_run_at', { ascending: true })
    .limit(batchSize * 2); // fetch extra for tenant fairness filtering

  if (jobsError) throw jobsError;
  if (!jobs || jobs.length === 0) {
    return { processed: 0, errors: 0, remaining: 0 };
  }

  // Tenant fairness: limit jobs per tenant
  const tenantJobCount = new Map<string, number>();
  const { data: processingJobs } = await supabase
    .from('jobs')
    .select('tenant_id')
    .eq('state', 'processing');

  if (processingJobs) {
    for (const j of processingJobs) {
      if (j.tenant_id) {
        tenantJobCount.set(j.tenant_id, (tenantJobCount.get(j.tenant_id) || 0) + 1);
      }
    }
  }

  const selectedJobs: any[] = [];
  for (const job of jobs) {
    if (selectedJobs.length >= batchSize) break;
    const tid = job.tenant_id || '__none__';
    const currentCount = tenantJobCount.get(tid) || 0;
    if (currentCount >= maxJobsPerTenant) {
      continue; // skip, this tenant has enough running
    }
    selectedJobs.push(job);
    tenantJobCount.set(tid, currentCount + 1);
  }

  console.log(`Processing ${selectedJobs.length} jobs (batch=${batchSize}, concurrency=${concurrency}, fairness=${maxJobsPerTenant}/tenant)`);

  let processedCount = 0;
  let errorCount = 0;

  // Process in concurrent chunks
  for (let i = 0; i < selectedJobs.length; i += concurrency) {
    const chunk = selectedJobs.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      chunk.map(job => executeJob(supabase, job, policy))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        processedCount++;
      } else {
        errorCount++;
      }
    }

    if (i + concurrency < selectedJobs.length && interJobDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, interJobDelayMs));
    }
  }

  // Count remaining
  const { count: remaining } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('state', 'ready')
    .lte('next_run_at', new Date().toISOString());

  return { processed: processedCount, errors: errorCount, remaining: remaining ?? 0 };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    let chainDepth = 0;
    try {
      const body = await req.json();
      chainDepth = body?.chainDepth ?? 0;
    } catch { /* no body */ }

    console.log(`Job scheduler (chain=${chainDepth})...`);

    const [policy, scaling] = await Promise.all([
      loadRetryPolicy(supabase),
      loadScalingConfig(supabase),
    ]);

    // Get current queue size for scaling decision
    const { count: queueSize } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('state', 'ready')
      .lte('next_run_at', new Date().toISOString());

    const currentQueueSize = queueSize ?? 0;
    const isHighLoad = currentQueueSize >= scaling.queueAlertThreshold;
    const batchSize = isHighLoad ? scaling.scaleBatchSize : scaling.normalBatchSize;
    const concurrency = isHighLoad ? Math.min(scaling.concurrency + 1, 5) : scaling.concurrency;

    if (isHighLoad) {
      console.log(`⚡ High load: ${currentQueueSize} jobs — batch=${batchSize}, concurrency=${concurrency}`);
    }

    await checkQueueHealth(supabase, currentQueueSize, scaling);

    const result = await processBatch(supabase, policy, batchSize, concurrency, scaling.interJobDelayMs, scaling.maxJobsPerTenant);

    console.log(`Done: ${result.processed} ok, ${result.errors} err, ${result.remaining} remaining`);

    // Chain re-invocation if there are more jobs
    if (result.remaining > 0 && chainDepth < scaling.maxChainedInvocations) {
      console.log(`🔄 Chain ${chainDepth + 1}/${scaling.maxChainedInvocations}, ${result.remaining} remaining`);

      fetch(`${SUPABASE_URL}/functions/v1/job-scheduler`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ chainDepth: chainDepth + 1 }),
      }).catch(e => console.error('Failed to chain scheduler:', e));

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: result.processed,
        errors: result.errors,
        remaining: result.remaining,
        batchSize,
        concurrency,
        chainDepth,
        scaled: isHighLoad,
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
