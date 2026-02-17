import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const dbUrlEnv = Deno.env.get("SUPABASE_DB_URL");

  try {
    if (!dbUrlEnv) {
      return new Response(
        JSON.stringify({ error: "SUPABASE_DB_URL not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { default: postgres } = await import(
      "https://deno.land/x/postgresjs@v3.4.5/mod.js"
    );
    const sql = postgres(dbUrlEnv, { max: 1 });

    // Query all custom triggers on public tables with function source
    const triggers = await sql.unsafe(`
      SELECT
        t.tgname AS trigger_name,
        c.relname AS table_name,
        p.proname AS function_name,
        CASE t.tgenabled
          WHEN 'O' THEN 'enabled'
          WHEN 'D' THEN 'disabled'
          WHEN 'R' THEN 'replica'
          WHEN 'A' THEN 'always'
          ELSE t.tgenabled::text
        END AS status,
        array_to_string(ARRAY[
          CASE WHEN t.tgtype::int & 4 = 4 THEN 'INSERT' END,
          CASE WHEN t.tgtype::int & 8 = 8 THEN 'DELETE' END,
          CASE WHEN t.tgtype::int & 16 = 16 THEN 'UPDATE' END,
          CASE WHEN t.tgtype::int & 32 = 32 THEN 'TRUNCATE' END
        ]::text[], ', ') AS events,
        pg_catalog.pg_get_functiondef(p.oid) AS function_source
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE NOT t.tgisinternal AND n.nspname = 'public'
      ORDER BY c.relname, t.tgname
    `);

    // Detect triggers writing to jobs
    const jobWriters = triggers.filter(
      (t: any) =>
        t.function_source &&
        (t.function_source.includes("INSERT INTO jobs") ||
          t.function_source.includes("insert into jobs")),
    );

    // Detect triggers writing to pending_product_syncs
    const pendingWriters = triggers.filter(
      (t: any) =>
        t.function_source?.includes("pending_product_syncs"),
    );

    // Group by table to find duplicates
    function findDuplicates(items: any[]) {
      const byTable: Record<string, any[]> = {};
      for (const t of items) {
        if (!byTable[t.table_name]) byTable[t.table_name] = [];
        byTable[t.table_name].push(t);
      }
      return Object.entries(byTable)
        .filter(([, trigs]) => trigs.length > 1)
        .map(([table, trigs]) => ({
          table,
          triggers: trigs.map((t: any) => ({
            name: t.trigger_name,
            function: t.function_name,
          })),
        }));
    }

    const jobDuplicates = findDuplicates(jobWriters);
    const pendingDuplicates = findDuplicates(pendingWriters);

    // Check for missing safety patterns
    const unsafeTriggers = [...jobWriters, ...pendingWriters].filter(
      (t: any) =>
        !t.function_source?.includes("unique_violation") &&
        !t.function_source?.includes("ON CONFLICT"),
    );

    const totalConflicts = jobDuplicates.length + pendingDuplicates.length;
    const totalUnsafe = unsafeTriggers.length;

    // Build conflict state
    const conflictState = {
      checked_at: new Date().toISOString(),
      total_triggers: triggers.length,
      job_writer_count: jobWriters.length,
      pending_writer_count: pendingWriters.length,
      conflicts: totalConflicts,
      unsafe_triggers: totalUnsafe,
      job_duplicates: jobDuplicates,
      pending_duplicates: pendingDuplicates,
      unsafe_trigger_names: unsafeTriggers.map((t: any) => ({
        trigger: t.trigger_name,
        table: t.table_name,
        function: t.function_name,
        missing: [
          !t.function_source?.includes("unique_violation") && !t.function_source?.includes("ON CONFLICT")
            ? "idempotent_insert"
            : null,
          !t.function_source?.includes("queue_size") && !t.function_source?.includes("max_queue")
            ? "backpressure"
            : null,
        ].filter(Boolean),
      })),
      severity: totalConflicts > 0 ? "critical" : totalUnsafe > 0 ? "warning" : "ok",
    };

    // Load previous state to detect NEW conflicts
    const { data: prevConfig } = await supabase
      .from("config")
      .select("value")
      .eq("key", "trigger_conflict_state")
      .maybeSingle();

    const prevState = prevConfig?.value as any;
    const prevConflicts = prevState?.conflicts ?? 0;
    const prevUnsafe = prevState?.unsafe_triggers ?? 0;

    // Store updated state
    await supabase.from("config").upsert({
      key: "trigger_conflict_state",
      value: conflictState as any,
      updated_at: new Date().toISOString(),
    });

    // If new conflicts appeared, write changelog alert
    if (totalConflicts > prevConflicts) {
      const newDupeCount = totalConflicts - prevConflicts;
      const tables = [...jobDuplicates, ...pendingDuplicates].map((d) => d.table).join(", ");
      
      // Get first tenant for changelog
      const { data: tenant } = await supabase
        .from("tenants")
        .select("id")
        .limit(1)
        .single();

      if (tenant) {
        await supabase.from("changelog").insert({
          tenant_id: tenant.id,
          event_type: "TRIGGER_CONFLICT",
          description: `⚠️ ${newDupeCount} nieuwe trigger-conflicten gedetecteerd op tabellen: ${tables}. Meerdere triggers schrijven naar dezelfde doeltabel.`,
          metadata: {
            job_duplicates: jobDuplicates,
            pending_duplicates: pendingDuplicates,
          },
        });
      }
    }

    if (totalUnsafe > prevUnsafe) {
      const newUnsafe = totalUnsafe - prevUnsafe;
      const names = unsafeTriggers.map((t: any) => `${t.trigger_name} (${t.table_name})`).join(", ");

      const { data: tenant } = await supabase
        .from("tenants")
        .select("id")
        .limit(1)
        .single();

      if (tenant) {
        await supabase.from("changelog").insert({
          tenant_id: tenant.id,
          event_type: "TRIGGER_UNSAFE",
          description: `🔓 ${newUnsafe} trigger(s) zonder idempotent insert gevonden: ${names}`,
          metadata: {
            unsafe_triggers: conflictState.unsafe_trigger_names,
          },
        });
      }
    }

    await sql.end();

    return new Response(
      JSON.stringify(conflictState),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("Trigger conflict check error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
