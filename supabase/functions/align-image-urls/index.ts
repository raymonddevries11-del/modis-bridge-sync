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

  try {
    // Step 1: Build complete map of storage files (lowercase key -> actual name)
    console.log("Building storage file index...");
    const storageMap = new Map<string, string>(); // lowercase -> actual name

    for (const prefix of ["", "modis/foto"]) {
      let offset = 0;
      const limit = 1000;
      while (true) {
        const { data: files, error } = await supabase.storage
          .from("product-images")
          .list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } });

        if (error || !files || files.length === 0) break;

        for (const f of files) {
          if (!f.name || f.id === null) continue; // skip folders
          const fullPath = prefix ? `${prefix}/${f.name}` : f.name;
          storageMap.set(fullPath.toLowerCase(), fullPath);
        }

        if (files.length < limit) break;
        offset += limit;
      }
    }

    console.log(`Indexed ${storageMap.size} storage files`);

    // Step 2: Get all products with bucket image URLs
    const BATCH = 500;
    let dbOffset = 0;
    let totalProducts = 0;
    let fixedProducts = 0;
    let fixedUrls = 0;
    let stillMissing = 0;
    let alreadyCorrect = 0;

    const baseUrl = Deno.env.get("SUPABASE_URL")! + "/storage/v1/object/public/product-images/";

    while (true) {
      const { data: products, error } = await supabase
        .from("products")
        .select("id, images, sku")
        .not("images", "is", null)
        .range(dbOffset, dbOffset + BATCH - 1);

      if (error) {
        console.error(`Fetch error at offset ${dbOffset}: ${error.message}`);
        break;
      }
      if (!products || products.length === 0) break;

      for (const prod of products) {
        if (!prod.images || !Array.isArray(prod.images) || prod.images.length === 0) continue;
        totalProducts++;

        let changed = false;
        const newImages: string[] = [];

        for (const url of prod.images as string[]) {
          if (typeof url !== "string") {
            newImages.push(url);
            continue;
          }

          // Extract the path after /product-images/
          if (!url.includes("/product-images/")) {
            // Not a bucket URL (relative path or external) — try to resolve
            if (url.startsWith("modis/foto/")) {
              const filename = url.replace("modis/foto/", "");
              // Try root lowercase, root uppercase, modis/foto/
              const lookups = [
                filename.toLowerCase(),
                `modis/foto/${filename.toLowerCase()}`,
              ];
              let resolved = false;
              for (const key of lookups) {
                const actual = storageMap.get(key);
                if (actual) {
                  newImages.push(baseUrl + actual);
                  changed = true;
                  fixedUrls++;
                  resolved = true;
                  break;
                }
              }
              if (!resolved) {
                newImages.push(url);
                stillMissing++;
              }
            } else {
              newImages.push(url);
            }
            continue;
          }

          const pathInBucket = url.replace(/^.*\/product-images\//, "");
          const lowerKey = pathInBucket.toLowerCase();

          // Check exact match first
          if (storageMap.has(pathInBucket.toLowerCase()) && storageMap.get(pathInBucket.toLowerCase()) === pathInBucket) {
            newImages.push(url);
            alreadyCorrect++;
            continue;
          }

          // Try to find the file with case-insensitive lookup
          const actualName = storageMap.get(lowerKey);
          if (actualName) {
            if (actualName !== pathInBucket) {
              // Found with different case — fix the URL
              newImages.push(baseUrl + actualName);
              changed = true;
              fixedUrls++;
            } else {
              newImages.push(url);
              alreadyCorrect++;
            }
            continue;
          }

          // Try modis/foto/ prefix
          const modisKey = `modis/foto/${lowerKey}`;
          const modisActual = storageMap.get(modisKey);
          if (modisActual) {
            newImages.push(baseUrl + modisActual);
            changed = true;
            fixedUrls++;
            continue;
          }

          // Truly missing
          newImages.push(url);
          stillMissing++;
        }

        if (changed && !dryRun) {
          const { error: updErr } = await supabase
            .from("products")
            .update({ images: newImages, updated_at: new Date().toISOString() })
            .eq("id", prod.id);

          if (updErr) {
            console.error(`Update error for ${prod.sku}: ${updErr.message}`);
          } else {
            fixedProducts++;
          }
        } else if (changed) {
          fixedProducts++;
        }
      }

      if (products.length < BATCH) break;
      dbOffset += BATCH;
    }

    const result = {
      dryRun,
      storageFilesIndexed: storageMap.size,
      totalProductsChecked: totalProducts,
      productsFixed: fixedProducts,
      urlsFixed: fixedUrls,
      urlsAlreadyCorrect: alreadyCorrect,
      urlsStillMissing: stillMissing,
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
