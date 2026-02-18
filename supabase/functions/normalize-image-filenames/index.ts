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
  const batchSize = body.batchSize ?? 200;

  try {
    // Step 1: List all .JPG files in storage root (uppercase extension)
    const uppercaseFiles: string[] = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const { data: files, error } = await supabase.storage
        .from("product-images")
        .list("", { limit, offset, sortBy: { column: "name", order: "asc" } });

      if (error) throw new Error(`List error: ${error.message}`);
      if (!files || files.length === 0) break;

      for (const f of files) {
        if (f.name && /\.(JPG|JPEG|PNG)$/.test(f.name)) {
          uppercaseFiles.push(f.name);
        }
      }

      if (files.length < limit) break;
      offset += limit;
    }

    // Also check modis/foto/ subdirectory
    offset = 0;
    while (true) {
      const { data: files, error } = await supabase.storage
        .from("product-images")
        .list("modis/foto", { limit, offset, sortBy: { column: "name", order: "asc" } });

      if (error) break;
      if (!files || files.length === 0) break;

      for (const f of files) {
        if (f.name && /\.(JPG|JPEG|PNG)$/.test(f.name)) {
          uppercaseFiles.push(`modis/foto/${f.name}`);
        }
      }

      if (files.length < limit) break;
      offset += limit;
    }

    console.log(`Found ${uppercaseFiles.length} files with uppercase extensions`);

    if (dryRun) {
      return new Response(
        JSON.stringify({
          dryRun: true,
          uppercaseFiles: uppercaseFiles.length,
          samples: uppercaseFiles.slice(0, 20),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 2: For each uppercase file, download -> upload as lowercase -> delete original
    let renamed = 0;
    let errors = 0;
    let skipped = 0;
    const errorDetails: { file: string; error: string }[] = [];

    const toProcess = uppercaseFiles.slice(0, batchSize);
    console.log(`Processing ${toProcess.length} files (batch limit: ${batchSize})`);

    for (let i = 0; i < toProcess.length; i += 5) {
      const batch = toProcess.slice(i, i + 5);

      await Promise.all(
        batch.map(async (oldName) => {
          const newName = oldName.replace(/\.JPG$/, ".jpg").replace(/\.JPEG$/, ".jpeg").replace(/\.PNG$/, ".png");

          try {
            // Download the file
            const { data: fileData, error: dlError } = await supabase.storage
              .from("product-images")
              .download(oldName);

            if (dlError || !fileData) {
              errors++;
              errorDetails.push({ file: oldName, error: dlError?.message || "download failed" });
              return;
            }

            // Check if lowercase version already exists
            const { data: existing } = await supabase.storage
              .from("product-images")
              .download(newName);

            if (existing) {
              // Lowercase already exists, just delete the uppercase
              await supabase.storage.from("product-images").remove([oldName]);
              skipped++;
              return;
            }

            // Upload as lowercase
            const buffer = await fileData.arrayBuffer();
            const { error: upError } = await supabase.storage
              .from("product-images")
              .upload(newName, buffer, {
                contentType: "image/jpeg",
                upsert: false,
              });

            if (upError) {
              if (upError.message?.includes("already exists") || upError.message?.includes("Duplicate")) {
                // Already exists as lowercase, delete uppercase
                await supabase.storage.from("product-images").remove([oldName]);
                skipped++;
                return;
              }
              errors++;
              errorDetails.push({ file: oldName, error: upError.message });
              return;
            }

            // Delete the uppercase original
            const { error: delError } = await supabase.storage
              .from("product-images")
              .remove([oldName]);

            if (delError) {
              console.warn(`⚠ Uploaded ${newName} but failed to delete ${oldName}: ${delError.message}`);
            }

            renamed++;
          } catch (e) {
            errors++;
            errorDetails.push({ file: oldName, error: e.message });
          }
        })
      );

      if ((i + 5) % 50 === 0 || i + 5 >= toProcess.length) {
        console.log(`Progress: ${Math.min(i + 5, toProcess.length)}/${toProcess.length} (renamed: ${renamed}, skipped: ${skipped}, errors: ${errors})`);
      }
    }

    // Step 3: Update all DB URLs to lowercase extensions
    console.log("\nStep 3: Updating DB image URLs to lowercase...");
    const { data: updatedProducts, error: dbError } = await supabase.rpc("exec_sql", {});
    // Can't use RPC for raw SQL, so update via direct queries

    // Update products with uppercase .JPG in URLs
    let dbFixed = 0;
    let dbOffset = 0;
    const DB_BATCH = 500;

    while (true) {
      const { data: prods, error: fetchErr } = await supabase
        .from("products")
        .select("id, images")
        .filter("images", "like", "%.JPG%")
        .range(dbOffset, dbOffset + DB_BATCH - 1);

      if (fetchErr) {
        console.error(`DB fetch error: ${fetchErr.message}`);
        break;
      }
      if (!prods || prods.length === 0) break;

      for (const prod of prods) {
        if (!prod.images || !Array.isArray(prod.images)) continue;

        const newImages = (prod.images as string[]).map((url: string) => {
          if (typeof url === "string") {
            return url.replace(/\.JPG$/i, ".jpg").replace(/\.JPEG$/i, ".jpeg").replace(/\.PNG$/i, ".png");
          }
          return url;
        });

        const changed = JSON.stringify(newImages) !== JSON.stringify(prod.images);
        if (changed) {
          const { error: updErr } = await supabase
            .from("products")
            .update({ images: newImages, updated_at: new Date().toISOString() })
            .eq("id", prod.id);

          if (!updErr) dbFixed++;
        }
      }

      if (prods.length < DB_BATCH) break;
      dbOffset += DB_BATCH;
    }

    // Also fix lowercase URLs that point to non-existent files but uppercase exists
    // (reverse case: DB has .jpg but storage has .JPG — should be resolved by renaming above)

    console.log(`DB URLs fixed: ${dbFixed}`);

    return new Response(
      JSON.stringify({
        storageRenamed: renamed,
        storageSkipped: skipped,
        storageErrors: errors,
        dbUrlsFixed: dbFixed,
        totalUppercaseInStorage: uppercaseFiles.length,
        errorDetails: errorDetails.slice(0, 20),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Fatal error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
