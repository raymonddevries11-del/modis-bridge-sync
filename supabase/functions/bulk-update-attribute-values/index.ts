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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify JWT from Authorization header
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action, attributeName, oldValue, newValue } = body as {
      action: "rename" | "delete";
      attributeName: string;
      oldValue: string;
      newValue?: string;
    };

    if (!attributeName || !oldValue) {
      return new Response(
        JSON.stringify({ error: "attributeName and oldValue are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (action === "rename" && !newValue) {
      return new Response(
        JSON.stringify({ error: "newValue is required for rename" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch all products that have this attribute
    let allProducts: { id: string; attributes: Record<string, string> }[] = [];
    let offset = 0;
    const BATCH = 1000;

    while (true) {
      const { data, error } = await supabase
        .from("products")
        .select("id, attributes")
        .not("attributes", "is", null)
        .range(offset, offset + BATCH - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const p of data) {
        const attrs = p.attributes as Record<string, string> | null;
        if (!attrs || !attrs[attributeName]) continue;
        const val = attrs[attributeName];
        // Check if this product's attribute contains the oldValue (comma-separated support)
        const parts = typeof val === "string" ? val.split(",").map((v: string) => v.trim()) : [];
        if (parts.includes(oldValue)) {
          allProducts.push({ id: p.id, attributes: attrs });
        }
      }

      if (data.length < BATCH) break;
      offset += BATCH;
    }

    let updatedCount = 0;

    // Process in batches of 100
    const UPDATE_BATCH = 100;
    for (let i = 0; i < allProducts.length; i += UPDATE_BATCH) {
      const batch = allProducts.slice(i, i + UPDATE_BATCH);
      const promises = batch.map((product) => {
        const currentVal = product.attributes[attributeName];
        const parts = typeof currentVal === "string"
          ? currentVal.split(",").map((v: string) => v.trim())
          : [];

        let newParts: string[];
        if (action === "rename") {
          newParts = parts.map((p) => (p === oldValue ? newValue! : p));
        } else {
          // delete
          newParts = parts.filter((p) => p !== oldValue);
        }

        const newAttrs = { ...product.attributes };
        if (newParts.length === 0) {
          delete newAttrs[attributeName];
        } else {
          newAttrs[attributeName] = newParts.join(", ");
        }

        return supabase
          .from("products")
          .update({ attributes: newAttrs })
          .eq("id", product.id);
      });

      const results = await Promise.all(promises);
      for (const r of results) {
        if (!r.error) updatedCount++;
      }
    }

    // Also update the attribute_definition's allowed_values if it exists
    const { data: def } = await supabase
      .from("attribute_definitions")
      .select("id, allowed_values")
      .eq("name", attributeName)
      .maybeSingle();

    if (def) {
      let newAllowed = [...def.allowed_values];
      if (action === "rename") {
        newAllowed = newAllowed.map((v) => (v === oldValue ? newValue! : v));
      } else {
        newAllowed = newAllowed.filter((v) => v !== oldValue);
      }
      await supabase
        .from("attribute_definitions")
        .update({ allowed_values: newAllowed })
        .eq("id", def.id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        action,
        attributeName,
        oldValue,
        newValue: newValue ?? null,
        productsUpdated: updatedCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
