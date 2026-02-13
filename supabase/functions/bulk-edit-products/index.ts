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
    const { productIds, action, payload } = body as {
      productIds: string[];
      action: "add_category" | "remove_category" | "set_attribute" | "remove_attribute" | "add_tag" | "remove_tag";
      payload: Record<string, string>;
    };

    if (!productIds || productIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "productIds required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let updated = 0;
    let skipped = 0;
    const BATCH = 200;

    for (let i = 0; i < productIds.length; i += BATCH) {
      const batchIds = productIds.slice(i, i + BATCH);

      // Fetch products in batch
      const { data: products, error: fetchErr } = await supabase
        .from("products")
        .select("id, categories, attributes, tags")
        .in("id", batchIds);

      if (fetchErr) throw fetchErr;
      if (!products) continue;

      for (const product of products) {
        let updateData: Record<string, any> | null = null;

        switch (action) {
          case "add_category": {
            const catName = payload.categoryName;
            if (!catName) break;
            const cats = Array.isArray(product.categories) ? product.categories : [];
            const alreadyHas = cats.some((c: any) =>
              typeof c === "string" ? c === catName : c?.name === catName
            );
            if (alreadyHas) { skipped++; break; }
            updateData = { categories: [...cats, catName] };
            break;
          }
          case "remove_category": {
            const catName = payload.categoryName;
            if (!catName) break;
            const cats = Array.isArray(product.categories) ? product.categories : [];
            const newCats = cats.filter((c: any) =>
              typeof c === "string" ? c !== catName : c?.name !== catName
            );
            if (newCats.length === cats.length) { skipped++; break; }
            updateData = { categories: newCats };
            break;
          }
          case "set_attribute": {
            const { attributeName, attributeValue } = payload;
            if (!attributeName) break;
            const attrs = (product.attributes as Record<string, any>) || {};
            if (attrs[attributeName] === attributeValue) { skipped++; break; }
            updateData = { attributes: { ...attrs, [attributeName]: attributeValue } };
            break;
          }
          case "remove_attribute": {
            const { attributeName } = payload;
            if (!attributeName) break;
            const attrs = (product.attributes as Record<string, any>) || {};
            if (!(attributeName in attrs)) { skipped++; break; }
            const newAttrs = { ...attrs };
            delete newAttrs[attributeName];
            updateData = { attributes: newAttrs };
            break;
          }
          case "add_tag": {
            const tag = payload.tag;
            if (!tag) break;
            const tags = Array.isArray(product.tags) ? product.tags : [];
            if (tags.includes(tag)) { skipped++; break; }
            updateData = { tags: [...tags, tag] };
            break;
          }
          case "remove_tag": {
            const tag = payload.tag;
            if (!tag) break;
            const tags = Array.isArray(product.tags) ? product.tags : [];
            if (!tags.includes(tag)) { skipped++; break; }
            updateData = { tags: tags.filter((t: string) => t !== tag) };
            break;
          }
        }

        if (updateData) {
          const { error: updateErr } = await supabase
            .from("products")
            .update(updateData)
            .eq("id", product.id);
          if (!updateErr) updated++;
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, updated, skipped, total: productIds.length }),
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
