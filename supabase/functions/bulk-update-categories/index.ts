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

    const { action, oldValue, newValue, filterType, filterValue } = await req.json();

    if (!action || !oldValue) {
      return new Response(JSON.stringify({ error: "action and oldValue required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "rename" && (!newValue || newValue.trim() === oldValue)) {
      return new Response(JSON.stringify({ error: "newValue must differ from oldValue" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch products – optionally filtered
    let offset = 0;
    const BATCH = 1000;
    let productsUpdated = 0;

    while (true) {
      let query = supabase
        .from("products")
        .select("id, categories, title, sku, brand_id")
        .not("categories", "is", null);

      // Apply optional filters for selective delete
      if (filterType === "brand" && filterValue) {
        query = query.eq("brand_id", filterValue);
      } else if (filterType === "search" && filterValue) {
        query = query.or(`title.ilike.%${filterValue}%,sku.ilike.%${filterValue}%`);
      }

      const { data: products, error } = await query.range(offset, offset + BATCH - 1);

      if (error) throw error;
      if (!products || products.length === 0) break;

      for (const product of products) {
        const cats = Array.isArray(product.categories) ? product.categories : [];

        // Categories can be strings or objects with {name: ...}
        const hasCategory = cats.some((cat: any) => {
          if (typeof cat === "string") return cat === oldValue;
          if (cat && typeof cat === "object" && cat.name) return cat.name === oldValue;
          return false;
        });

        if (!hasCategory) continue;

        let newCats: any[];
        if (action === "rename") {
          newCats = cats.map((cat: any) => {
            if (typeof cat === "string" && cat === oldValue) return newValue.trim();
            if (cat && typeof cat === "object" && cat.name === oldValue) return { ...cat, name: newValue.trim() };
            return cat;
          });
        } else {
          // delete
          newCats = cats.filter((cat: any) => {
            if (typeof cat === "string") return cat !== oldValue;
            if (cat && typeof cat === "object" && cat.name) return cat.name !== oldValue;
            return true;
          });
        }

        const { error: updateError } = await supabase
          .from("products")
          .update({ categories: newCats })
          .eq("id", product.id);

        if (updateError) {
          console.error(`Failed to update product ${product.id}:`, updateError);
          continue;
        }
        productsUpdated++;
      }

      if (products.length < BATCH) break;
      offset += BATCH;
    }

    return new Response(
      JSON.stringify({ success: true, action, oldValue, newValue: newValue || null, productsUpdated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
