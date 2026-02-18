import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Pre-sync normalization job:
 * 1. Scans all product image URLs for uppercase extensions (.JPG, .PNG, .JPEG)
 * 2. Verifies the lowercase version exists in storage (case-sensitive check)
 * 3. Updates DB URLs to use lowercase extensions where storage file exists
 * 4. Reports mismatches where storage only has uppercase (needs rename)
 */
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
    const { data: tenantRow } = await supabase
      .from("tenants").select("id").eq("slug", tenant).single();
    if (!tenantRow) throw new Error("Tenant not found");

    // ── Step 1: Build storage index (lowercase key → actual path) ──
    console.log("Building storage index...");
    const storageMap = new Map<string, string>();

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

    // ── Step 2: Scan products for uppercase extensions ──
    console.log("Scanning product URLs...");
    const baseUrl = Deno.env.get("SUPABASE_URL")! + "/storage/v1/object/public/product-images/";
    const BATCH = 500;
    let dbOffset = 0;

    let totalScanned = 0;
    let productsFixed = 0;
    let urlsNormalized = 0;
    let urlsCaseMismatch = 0;
    let urlsStorageMissing = 0;
    const storageMismatchSamples: string[] = [];

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
        totalScanned++;

        let changed = false;
        const newImages: string[] = [];

        for (const rawUrl of prod.images as string[]) {
          if (typeof rawUrl !== "string" || !rawUrl.trim()) {
            newImages.push(rawUrl);
            continue;
          }

          const url = rawUrl.trim();

          // Only process storage URLs
          if (!url.includes("/product-images/")) {
            newImages.push(url);
            continue;
          }

          const pathInBucket = url.replace(/^.*\/product-images\//, "");

          // Check if extension is uppercase
          const hasUpperExt = /\.(JPG|JPEG|PNG|GIF|WEBP)(\?|$)/.test(pathInBucket);
          const lowerPath = pathInBucket.toLowerCase();
          const lowerExtUrl = url
            .replace(/\.JPG(\?|$)/gi, ".jpg$1")
            .replace(/\.JPEG(\?|$)/gi, ".jpeg$1")
            .replace(/\.PNG(\?|$)/gi, ".png$1")
            .replace(/\.GIF(\?|$)/gi, ".gif$1")
            .replace(/\.WEBP(\?|$)/gi, ".webp$1");

          // Look up the actual storage path
          const actualPath = storageMap.get(lowerPath);

          if (actualPath) {
            // Storage file found — use correct casing from storage
            const correctUrl = baseUrl + actualPath;
            if (correctUrl !== url) {
              newImages.push(correctUrl);
              changed = true;
              if (hasUpperExt) urlsNormalized++;
              else urlsCaseMismatch++;
            } else {
              newImages.push(url);
            }
          } else {
            // File not in storage at all
            if (lowerExtUrl !== url) {
              // At least normalize the URL extension to lowercase
              newImages.push(lowerExtUrl);
              changed = true;
              urlsNormalized++;
            } else {
              newImages.push(url);
            }
            urlsStorageMissing++;
            if (storageMismatchSamples.length < 15) {
              storageMismatchSamples.push(pathInBucket);
            }
          }
        }

        if (changed && !dryRun) {
          const { error: updErr } = await supabase
            .from("products")
            .update({ images: newImages, updated_at: new Date().toISOString() })
            .eq("id", prod.id);
          if (updErr) console.error(`Update ${prod.sku}: ${updErr.message}`);
          else productsFixed++;
        } else if (changed) {
          productsFixed++;
        }
      }

      if (products.length < BATCH) break;
      dbOffset += BATCH;
    }

    // ── Step 3: Log to changelog ──
    if (!dryRun && (productsFixed > 0 || urlsNormalized > 0)) {
      await supabase.from("changelog").insert({
        tenant_id: tenantRow.id,
        event_type: "IMAGE_URL_NORMALIZE",
        description: `Normalized: ${urlsNormalized} extensions, ${urlsCaseMismatch} case fixes across ${productsFixed} products`,
        metadata: { productsFixed, urlsNormalized, urlsCaseMismatch, urlsStorageMissing },
      });
    }

    const result = {
      dryRun,
      storageFilesIndexed: storageMap.size,
      totalProductsScanned: totalScanned,
      productsFixed,
      urlsNormalized,
      urlsCaseMismatch,
      urlsStorageMissing,
      storageMismatchSamples,
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
