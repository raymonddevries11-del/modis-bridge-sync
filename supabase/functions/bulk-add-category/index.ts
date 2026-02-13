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

    const { categoryName, filterType, filterValue } = await req.json();

    if (!categoryName?.trim()) {
      return new Response(JSON.stringify({ error: "categoryName is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const catName = categoryName.trim();

    // Build query based on filter
    let offset = 0;
    const BATCH = 500;
    let productsUpdated = 0;
    let productsSkipped = 0;

    while (true) {
      let query = supabase
        .from("products")
        .select("id, categories")
        .range(offset, offset + BATCH - 1);

      // Apply filters
      if (filterType === "category" && filterValue) {
        query = query.not("categories", "is", null);
      } else if (filterType === "brand" && filterValue) {
        query = query.eq("brand_id", filterValue);
      } else if (filterType === "search" && filterValue) {
        query = query.or(`title.ilike.%${filterValue}%,sku.ilike.%${filterValue}%`);
      }
      // filterType === "all" → no additional filter

      const { data: products, error } = await query;
      if (error) throw error;
      if (!products || products.length === 0) break;

      const updates: { id: string; categories: any[] }[] = [];

      for (const product of products) {
        const cats = Array.isArray(product.categories) ? product.categories : [];

        // Filter by existing category if needed
        if (filterType === "category" && filterValue) {
          const hasFilterCat = cats.some((c: any) => {
            if (typeof c === "string") return c === filterValue;
            if (c && typeof c === "object" && c.name) return c.name === filterValue;
            return false;
          });
          if (!hasFilterCat) continue;
        }

        // Check if category already exists
        const alreadyHas = cats.some((c: any) => {
          if (typeof c === "string") return c === catName;
          if (c && typeof c === "object" && c.name) return c.name === catName;
          return false;
        });

        if (alreadyHas) {
          productsSkipped++;
          continue;
        }

        updates.push({ id: product.id, categories: [...cats, catName] });
      }

      // Batch update
      for (const upd of updates) {
        const { error: updateError } = await supabase
          .from("products")
          .update({ categories: upd.categories })
          .eq("id", upd.id);

        if (updateError) {
          console.error(`Failed to update product ${upd.id}:`, updateError);
          continue;
        }
        productsUpdated++;
      }

      if (products.length < BATCH) break;
      offset += BATCH;
    }

    return new Response(
      JSON.stringify({ success: true, categoryName: catName, productsUpdated, productsSkipped }),
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
