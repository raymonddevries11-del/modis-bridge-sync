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

  try {
    // Verify admin
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: user.id,
      _role: "admin",
    });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Query triggers from pg_trigger
    const { data: dbUrl } = await supabase
      .from("config")
      .select("value")
      .eq("key", "__unused__")
      .maybeSingle();

    // Use supabase rpc or raw — we'll query pg_trigger via a dedicated function
    // Since we can't run raw SQL from the client, we query the catalog directly
    // via the service role connection.

    // Fetch all custom triggers (non-internal) on public schema tables
    const triggerQuery = `
      SELECT
        t.tgname AS trigger_name,
        c.relname AS table_name,
        n.nspname AS schema_name,
        p.proname AS function_name,
        CASE t.tgenabled
          WHEN 'O' THEN 'enabled'
          WHEN 'D' THEN 'disabled'
          WHEN 'R' THEN 'replica'
          WHEN 'A' THEN 'always'
          ELSE t.tgenabled::text
        END AS status,
        CASE
          WHEN t.tgtype::int & 2 = 2 THEN 'BEFORE'
          WHEN t.tgtype::int & 64 = 64 THEN 'INSTEAD OF'
          ELSE 'AFTER'
        END AS timing,
        array_to_string(ARRAY[
          CASE WHEN t.tgtype::int & 4 = 4 THEN 'INSERT' END,
          CASE WHEN t.tgtype::int & 8 = 8 THEN 'DELETE' END,
          CASE WHEN t.tgtype::int & 16 = 16 THEN 'UPDATE' END,
          CASE WHEN t.tgtype::int & 32 = 32 THEN 'TRUNCATE' END
        ]::text[], ', ') AS events,
        CASE WHEN t.tgtype::int & 1 = 1 THEN 'FOR EACH ROW' ELSE 'FOR EACH STATEMENT' END AS level,
        pg_catalog.pg_get_functiondef(p.oid) AS function_source
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE NOT t.tgisinternal
        AND n.nspname = 'public'
      ORDER BY c.relname, t.tgname
    `;

    // We need to use the database URL for this query
    const dbUrlEnv = Deno.env.get("SUPABASE_DB_URL");
    if (!dbUrlEnv) {
      return new Response(
        JSON.stringify({ error: "SUPABASE_DB_URL not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Use postgres driver
    const { default: postgres } = await import(
      "https://deno.land/x/postgresjs@v3.4.5/mod.js"
    );
    const sql = postgres(dbUrlEnv, { max: 1 });

    const triggers = await sql.unsafe(triggerQuery);

    // Detect duplicates: multiple triggers on the same table writing to `jobs`
    const jobWritingTriggers = triggers.filter(
      (t: any) =>
        t.function_source &&
        (t.function_source.includes("INSERT INTO jobs") ||
          t.function_source.includes("insert into jobs")),
    );

    // Group by table
    const byTable: Record<string, any[]> = {};
    for (const t of jobWritingTriggers) {
      if (!byTable[t.table_name]) byTable[t.table_name] = [];
      byTable[t.table_name].push(t);
    }

    const duplicates = Object.entries(byTable)
      .filter(([, trigs]) => trigs.length > 1)
      .map(([table, trigs]) => ({
        table,
        triggers: trigs.map((t: any) => ({
          name: t.trigger_name,
          function: t.function_name,
        })),
      }));

    // Also detect triggers writing to pending_product_syncs
    const pendingWritingTriggers = triggers.filter(
      (t: any) =>
        t.function_source &&
        (t.function_source.includes("pending_product_syncs")),
    );
    const pendingByTable: Record<string, any[]> = {};
    for (const t of pendingWritingTriggers) {
      if (!pendingByTable[t.table_name]) pendingByTable[t.table_name] = [];
      pendingByTable[t.table_name].push(t);
    }
    const pendingDuplicates = Object.entries(pendingByTable)
      .filter(([, trigs]) => trigs.length > 1)
      .map(([table, trigs]) => ({
        table,
        triggers: trigs.map((t: any) => ({
          name: t.trigger_name,
          function: t.function_name,
        })),
      }));

    // Clean up function_source for response (truncate large sources)
    const cleanTriggers = triggers.map((t: any) => ({
      trigger_name: t.trigger_name,
      table_name: t.table_name,
      schema_name: t.schema_name,
      function_name: t.function_name,
      status: t.status,
      timing: t.timing,
      events: t.events,
      level: t.level,
      writes_to_jobs:
        t.function_source?.includes("INSERT INTO jobs") ||
        t.function_source?.includes("insert into jobs") ||
        false,
      writes_to_pending:
        t.function_source?.includes("pending_product_syncs") || false,
      uses_idempotent_insert:
        t.function_source?.includes("unique_violation") || false,
      uses_backpressure:
        t.function_source?.includes("queue_size") ||
        t.function_source?.includes("max_queue") ||
        false,
      function_source_preview: t.function_source
        ? t.function_source.substring(0, 500)
        : null,
    }));

    await sql.end();

    return new Response(
      JSON.stringify({
        triggers: cleanTriggers,
        duplicates: {
          job_writers: duplicates,
          pending_writers: pendingDuplicates,
        },
        summary: {
          total: cleanTriggers.length,
          job_writers: jobWritingTriggers.length,
          pending_writers: pendingWritingTriggers.length,
          duplicate_tables: duplicates.length + pendingDuplicates.length,
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("Trigger audit error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
