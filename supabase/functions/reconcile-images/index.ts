import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dryRun ?? false;
  const tenant = body.tenant ?? "kosterschoenmode";

  try {
    // Resolve tenant
    const { data: tenantRow } = await supabase
      .from("tenants").select("id").eq("slug", tenant).single();
    if (!tenantRow) throw new Error("Tenant not found");

    // ── Step 1: Build complete storage file index ──
    console.log("Step 1: Indexing storage bucket...");
    const storageMap = new Map<string, string>(); // lowercase path → actual path

    for (const prefix of ["", "modis/foto"]) {
      let offset = 0;
      while (true) {
        const { data: files, error } = await supabase.storage
          .from("product-images")
          .list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
        if (error || !files || files.length === 0) break;
        for (const f of files) {
          if (!f.name || f.id === null) continue;
          const fullPath = prefix ? `${prefix}/${f.name}` : f.name;
          storageMap.set(fullPath.toLowerCase(), fullPath);
        }
        if (files.length < 1000) break;
        offset += 1000;
      }
    }
    console.log(`Indexed ${storageMap.size} storage files`);

    // ── Step 2: Process all products ──
    console.log("Step 2: Scanning products...");
    const baseUrl = Deno.env.get("SUPABASE_URL")! + "/storage/v1/object/public/product-images/";
    const BATCH = 500;
    let dbOffset = 0;

    let totalProducts = 0;
    let productsFixed = 0;
    let urlsFixed = 0;
    let urlsAlreadyOk = 0;
    let urlsNotFound = 0;
    let normalizedExtensions = 0;
    const notFoundSamples: string[] = [];

    while (true) {
      const { data: products, error } = await supabase
        .from("products")
        .select("id, sku, images")
        .eq("tenant_id", tenantRow.id)
        .not("images", "is", null)
        .range(dbOffset, dbOffset + BATCH - 1);

      if (error) { console.error(`Fetch error: ${error.message}`); break; }
      if (!products || products.length === 0) break;

      for (const prod of products) {
        if (!Array.isArray(prod.images) || prod.images.length === 0) continue;
        totalProducts++;

        let changed = false;
        const newImages: string[] = [];

        for (const rawUrl of prod.images as string[]) {
          if (typeof rawUrl !== "string" || !rawUrl.trim()) { newImages.push(rawUrl); continue; }

          const url = rawUrl.trim().replace(/^"+|"+$/g, ""); // strip stray quotes

          // ── A) Already a valid storage URL ──
          if (url.includes("/product-images/")) {
            const pathInBucket = url.replace(/^.*\/product-images\//, "");
            const lowerKey = pathInBucket.toLowerCase();

            // Try exact match
            const actual = storageMap.get(lowerKey);
            if (actual && actual === pathInBucket) {
              // Also normalize extension case in URL
              const extNorm = normalizeExtension(url);
              if (extNorm !== url) { newImages.push(extNorm); changed = true; normalizedExtensions++; }
              else { newImages.push(url); urlsAlreadyOk++; }
              continue;
            }
            if (actual) {
              // Case mismatch → fix URL to match storage
              newImages.push(baseUrl + actual);
              changed = true; urlsFixed++;
              continue;
            }

            // Try modis/foto/ prefix
            const modisActual = storageMap.get(`modis/foto/${lowerKey}`);
            if (modisActual) {
              newImages.push(baseUrl + modisActual);
              changed = true; urlsFixed++;
              continue;
            }

            // Try just filename in root
            const filename = pathInBucket.split("/").pop()?.toLowerCase() || "";
            const rootActual = storageMap.get(filename);
            if (rootActual) {
              newImages.push(baseUrl + rootActual);
              changed = true; urlsFixed++;
              continue;
            }

            // Not found
            newImages.push(url);
            urlsNotFound++;
            if (notFoundSamples.length < 15) notFoundSamples.push(pathInBucket);
            continue;
          }

          // ── B) Relative path (modis/foto/... or just filename) ──
          if (!url.startsWith("http")) {
            const cleaned = url.replace(/\\/g, "/").replace(/^modis\/foto\//, "");
            const lookups = [
              cleaned.toLowerCase(),
              `modis/foto/${cleaned.toLowerCase()}`,
            ];
            let resolved = false;
            for (const key of lookups) {
              const actual = storageMap.get(key);
              if (actual) {
                newImages.push(baseUrl + actual);
                changed = true; urlsFixed++; resolved = true;
                break;
              }
            }
            if (!resolved) {
              newImages.push(url); urlsNotFound++;
              if (notFoundSamples.length < 15) notFoundSamples.push(cleaned);
            }
            continue;
          }

          // ── C) External URL → try to match filename in storage ──
          let filename = "";
          try { filename = new URL(url).pathname.split("/").pop() || ""; }
          catch { filename = url.split("/").pop() || ""; }

          if (filename) {
            const lookups = [
              filename.toLowerCase(),
              `modis/foto/${filename.toLowerCase()}`,
            ];
            let resolved = false;
            for (const key of lookups) {
              const actual = storageMap.get(key);
              if (actual) {
                newImages.push(baseUrl + actual);
                changed = true; urlsFixed++; resolved = true;
                break;
              }
            }
            if (!resolved) {
              newImages.push(url); urlsNotFound++;
              if (notFoundSamples.length < 15) notFoundSamples.push(filename);
            }
          } else {
            newImages.push(url);
          }
        }

        if (changed && !dryRun) {
          const { error: updErr } = await supabase
            .from("products")
            .update({ images: newImages, updated_at: new Date().toISOString() })
            .eq("id", prod.id);
          if (updErr) console.error(`Update error ${prod.sku}: ${updErr.message}`);
          else productsFixed++;
        } else if (changed) {
          productsFixed++;
        }
      }

      if (products.length < BATCH) break;
      dbOffset += BATCH;
    }

    // ── Step 3: Log to changelog ──
    if (!dryRun) {
      await supabase.from("changelog").insert({
        tenant_id: tenantRow.id,
        event_type: "IMAGE_RECONCILE",
        description: `Reconciled: ${productsFixed} products, ${urlsFixed} URLs fixed, ${urlsNotFound} not found`,
        metadata: { productsFixed, urlsFixed, urlsAlreadyOk, urlsNotFound, normalizedExtensions },
      });
    }

    const result = {
      dryRun,
      storageFilesIndexed: storageMap.size,
      totalProductsScanned: totalProducts,
      productsFixed,
      urlsFixed,
      urlsAlreadyOk,
      urlsNotFound,
      normalizedExtensions,
      notFoundSamples,
    };
    console.log("Result:", JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Fatal:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function normalizeExtension(url: string): string {
  return url
    .replace(/\.JPG(\?|$)/i, ".jpg$1")
    .replace(/\.JPEG(\?|$)/i, ".jpeg$1")
    .replace(/\.PNG(\?|$)/i, ".png$1");
}
