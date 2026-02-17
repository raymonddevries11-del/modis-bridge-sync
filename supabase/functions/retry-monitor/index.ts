import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface MonitorConfig {
  stuckThresholdMin: number;   // minutes before a processing job is "stuck" (default 15)
  maxRetries: number;          // max auto-retries before escalation (default 5)
  escalateAfterMin: number;    // escalate if stuck AND retried within this window (default 60)
  backoffBaseSec: number;      // base backoff seconds (default 30)
  backoffMaxSec: number;       // max backoff seconds (default 600)
}

const DEFAULT_CONFIG: MonitorConfig = {
  stuckThresholdMin: 15,
  maxRetries: 5,
  escalateAfterMin: 60,
  backoffBaseSec: 30,
  backoffMaxSec: 600,
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Load config
    let config = DEFAULT_CONFIG;
    try {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", "retry_monitor_config")
        .maybeSingle();
      if (data?.value) config = { ...DEFAULT_CONFIG, ...(data.value as Partial<MonitorConfig>) };
    } catch { /* use defaults */ }

    const now = new Date();
    const stuckCutoff = new Date(now.getTime() - config.stuckThresholdMin * 60_000).toISOString();

    // 1. Find stuck processing jobs
    const { data: stuckJobs } = await supabase
      .from("jobs")
      .select("id, type, state, attempts, error, tenant_id, payload, created_at, updated_at")
      .eq("state", "processing")
      .lt("updated_at", stuckCutoff);

    // 2. Find error jobs that could be retried (attempts < max)
    const { data: errorJobs } = await supabase
      .from("jobs")
      .select("id, type, state, attempts, error, tenant_id, payload, created_at, updated_at")
      .eq("state", "error")
      .lt("attempts", config.maxRetries)
      .order("updated_at", { ascending: true })
      .limit(20);

    let retriedCount = 0;
    let escalatedCount = 0;
    const actions: Array<{ jobId: string; type: string; action: string; reason: string }> = [];

    // Process stuck jobs
    for (const job of stuckJobs || []) {
      const attempts = job.attempts || 0;
      const jobAgeMin = (now.getTime() - new Date(job.created_at).getTime()) / 60_000;

      if (attempts >= config.maxRetries || jobAgeMin >= config.escalateAfterMin) {
        // Escalate — mark as error and log to changelog
        await supabase.from("jobs").update({
          state: "error",
          error: `Retry monitor: escalated after ${attempts} attempts, stuck for ${Math.round((now.getTime() - new Date(job.updated_at).getTime()) / 60_000)}min`,
          updated_at: now.toISOString(),
        }).eq("id", job.id);

        await supabase.from("changelog").insert({
          tenant_id: job.tenant_id,
          event_type: "JOB_ESCALATED",
          description: `Job ${job.type} geëscaleerd — ${attempts} pogingen, stuck >  ${config.stuckThresholdMin}min`,
          metadata: {
            jobId: job.id,
            jobType: job.type,
            attempts,
            lastError: job.error,
            stuckSince: job.updated_at,
            productIds: (job.payload as any)?.productIds?.slice(0, 5),
          },
        });

        escalatedCount++;
        actions.push({ jobId: job.id, type: job.type, action: "escalated", reason: `${attempts} attempts, age ${Math.round(jobAgeMin)}min` });
      } else {
        // Auto-retry with backoff
        const delaySec = Math.min(
          config.backoffBaseSec * Math.pow(2, attempts),
          config.backoffMaxSec,
        );
        const nextRetryAt = new Date(now.getTime() + delaySec * 1000).toISOString();

        await supabase.from("jobs").update({
          state: "ready",
          error: `Retry monitor: auto-retry #${attempts + 1} (was stuck ${Math.round((now.getTime() - new Date(job.updated_at).getTime()) / 60_000)}min)`,
          updated_at: nextRetryAt,
        }).eq("id", job.id);

        retriedCount++;
        actions.push({ jobId: job.id, type: job.type, action: "retried", reason: `attempt ${attempts + 1}, backoff ${delaySec}s` });
      }
    }

    // Process error jobs eligible for retry
    for (const job of errorJobs || []) {
      const attempts = job.attempts || 0;
      // Skip if the error was a recent escalation (within last 10 min)
      const updatedAt = new Date(job.updated_at).getTime();
      if (now.getTime() - updatedAt < 10 * 60_000) continue;

      // Check if it's a transient error (not a permanent/validation error)
      const permanentPatterns = ["Unknown job type", "Invalid", "Forbidden", "Unauthorized"];
      const isPermanent = permanentPatterns.some((p) => job.error?.includes(p));
      if (isPermanent) continue;

      const delaySec = Math.min(
        config.backoffBaseSec * Math.pow(2, attempts),
        config.backoffMaxSec,
      );
      const nextRetryAt = new Date(now.getTime() + delaySec * 1000).toISOString();

      await supabase.from("jobs").update({
        state: "ready",
        error: `Retry monitor: auto-retry from error #${attempts + 1} — ${job.error?.slice(0, 100)}`,
        updated_at: nextRetryAt,
      }).eq("id", job.id);

      retriedCount++;
      actions.push({ jobId: job.id, type: job.type, action: "retried_from_error", reason: `attempt ${attempts + 1}` });
    }

    // Save monitor state for the UI widget
    await supabase.from("config").upsert({
      key: "retry_monitor_state",
      value: {
        last_run: now.toISOString(),
        retried: retriedCount,
        escalated: escalatedCount,
        stuck_found: stuckJobs?.length ?? 0,
        error_retryable: errorJobs?.length ?? 0,
        actions: actions.slice(0, 20),
      },
      updated_at: now.toISOString(),
    }, { onConflict: "key" });

    console.log(`Retry monitor: ${retriedCount} retried, ${escalatedCount} escalated, ${stuckJobs?.length ?? 0} stuck found`);

    return new Response(
      JSON.stringify({
        success: true,
        retried: retriedCount,
        escalated: escalatedCount,
        stuckFound: stuckJobs?.length ?? 0,
        actions,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("Retry monitor error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
