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
    // Call the DB validation function
    const { data: violations, error } = await supabase.rpc(
      "validate_no_duplicate_triggers",
    );

    if (error) throw error;

    const passed = !violations || violations.length === 0;

    return new Response(
      JSON.stringify({
        passed,
        violation_count: violations?.length ?? 0,
        violations: violations ?? [],
        checked_at: new Date().toISOString(),
        message: passed
          ? "✅ No trigger violations found"
          : `❌ ${violations.length} violation(s) detected`,
      }),
      {
        status: passed ? 200 : 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error("Trigger validation error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
