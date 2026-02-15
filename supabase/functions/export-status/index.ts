import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const tenantId = url.searchParams.get("tenant_id");
    const status = url.searchParams.get("status"); // pending, uploaded, acked, timeout, quarantined
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
    const since = url.searchParams.get("since"); // ISO date filter

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Build query
    let query = supabase
      .from("export_files")
      .select("id, filename, order_number, ack_status, retry_count, max_retries, created_at, synced_at, uploaded_to_sftp_at, last_retry_at, tenant_id")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (tenantId) query = query.eq("tenant_id", tenantId);
    if (status) query = query.eq("ack_status", status);
    if (since) query = query.gte("created_at", since);

    const { data: files, error } = await query;
    if (error) throw error;

    // Compute summary stats
    const summary = {
      pending: 0,
      uploaded: 0,
      acked: 0,
      timeout: 0,
      quarantined: 0,
      total: 0,
    };

    // Get full counts (unfiltered by limit)
    let countQuery = supabase
      .from("export_files")
      .select("ack_status");
    if (tenantId) countQuery = countQuery.eq("tenant_id", tenantId);
    if (since) countQuery = countQuery.gte("created_at", since);

    const { data: allFiles } = await countQuery;
    if (allFiles) {
      for (const f of allFiles) {
        const s = f.ack_status as keyof typeof summary;
        if (s in summary) summary[s]++;
        summary.total++;
      }
    }

    return new Response(
      JSON.stringify({ summary, files, fetched_at: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
