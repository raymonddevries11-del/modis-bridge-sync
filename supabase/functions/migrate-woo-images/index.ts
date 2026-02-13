import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { tenantId, batchSize = 10, offset = 0, dryRun = false } =
      await req.json();

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: "tenantId required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get WooCommerce credentials
    const { data: config } = await supabase
      .from("tenant_config")
      .select("*")
      .eq("tenant_id", tenantId)
      .single();

    if (!config) {
      return new Response(
        JSON.stringify({ error: "No tenant config found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const wooBase = config.woocommerce_url.replace(/\/$/, "");
    const wooAuth = btoa(
      `${config.woocommerce_consumer_key}:${config.woocommerce_consumer_secret}`
    );

    // Find products with Storage URLs that might be 404s
    // We target products whose images reference the internal storage path
    const { data: products, error: fetchErr } = await supabase
      .from("products")
      .select("id, sku, images, title")
      .eq("tenant_id", tenantId)
      .not("images", "is", null)
      .order("sku")
      .range(offset, offset + batchSize - 1);

    if (fetchErr) throw fetchErr;

    // Filter to products with storage URLs pointing to modis/foto/
    const productsWithStorageImages = (products || []).filter((p) => {
      const imgs = p.images as string[];
      return (
        imgs &&
        imgs.length > 0 &&
        imgs.some((img: string) => img.includes("/product-images/modis/foto/"))
      );
    });

    console.log(
      `Batch ${offset}: ${productsWithStorageImages.length} products with storage images out of ${products?.length || 0}`
    );

    const results: any[] = [];

    for (const product of productsWithStorageImages) {
      const imgs = product.images as string[];

      // Check if first image actually exists (quick HEAD check)
      const firstImg = imgs[0];
      let firstImgExists = false;
      try {
        const headResp = await fetch(firstImg, { method: "HEAD" });
        firstImgExists = headResp.ok;
      } catch {
        firstImgExists = false;
      }

      if (firstImgExists) {
        results.push({
          sku: product.sku,
          status: "skipped",
          reason: "images already exist in storage",
        });
        continue;
      }

      // Fetch product from WooCommerce by SKU
      const searchSku = product.sku.replace(/000$/, ""); // Strip trailing 000
      let wooProduct: any = null;

      try {
        const wooResp = await fetch(
          `${wooBase}/wp-json/wc/v3/products?sku=${encodeURIComponent(searchSku)}&per_page=1`,
          {
            headers: { Authorization: `Basic ${wooAuth}` },
          }
        );

        if (!wooResp.ok) {
          results.push({
            sku: product.sku,
            status: "error",
            reason: `WooCommerce API error: ${wooResp.status}`,
          });
          continue;
        }

        const wooProducts = await wooResp.json();

        if (wooProducts.length === 0) {
          // Try with full SKU
          const wooResp2 = await fetch(
            `${wooBase}/wp-json/wc/v3/products?sku=${encodeURIComponent(product.sku)}&per_page=1`,
            {
              headers: { Authorization: `Basic ${wooAuth}` },
            }
          );
          const wooProducts2 = await wooResp2.json();
          if (wooProducts2.length > 0) {
            wooProduct = wooProducts2[0];
          }
        } else {
          wooProduct = wooProducts[0];
        }
      } catch (err) {
        results.push({
          sku: product.sku,
          status: "error",
          reason: `WooCommerce fetch failed: ${err.message}`,
        });
        continue;
      }

      if (!wooProduct || !wooProduct.images || wooProduct.images.length === 0) {
        results.push({
          sku: product.sku,
          status: "no_woo_images",
          reason: "Product not found in WooCommerce or has no images",
        });
        continue;
      }

      if (dryRun) {
        results.push({
          sku: product.sku,
          status: "dry_run",
          wooImageCount: wooProduct.images.length,
          wooImages: wooProduct.images.map((i: any) => i.src),
        });
        continue;
      }

      // Download images from WooCommerce and upload to Storage
      const newImageUrls: string[] = [];
      let imgIndex = 1;

      for (const wooImg of wooProduct.images) {
        const srcUrl = wooImg.src;
        if (!srcUrl) continue;

        try {
          // Download image from WooCommerce
          const imgResp = await fetch(srcUrl);
          if (!imgResp.ok) {
            console.warn(`Failed to download ${srcUrl}: ${imgResp.status}`);
            continue;
          }

          const imgData = await imgResp.arrayBuffer();
          const contentType =
            imgResp.headers.get("content-type") || "image/jpeg";

          // Determine file extension
          let ext = ".jpg";
          if (contentType.includes("png")) ext = ".png";
          else if (contentType.includes("webp")) ext = ".webp";

          // Upload to Storage with consistent naming
          const storagePath = `modis/foto/W-${imgIndex}_${product.sku.replace(/000$/, "")}${ext}`;

          const { error: uploadErr } = await supabase.storage
            .from("product-images")
            .upload(storagePath, imgData, {
              contentType,
              upsert: true,
            });

          if (uploadErr) {
            console.warn(`Upload failed for ${storagePath}: ${uploadErr.message}`);
            continue;
          }

          const publicUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}`;
          newImageUrls.push(publicUrl);
          imgIndex++;
        } catch (err) {
          console.warn(`Image processing failed for ${srcUrl}: ${err.message}`);
        }
      }

      if (newImageUrls.length > 0) {
        // Update product images in database
        const { error: updateErr } = await supabase
          .from("products")
          .update({ images: newImageUrls })
          .eq("id", product.id);

        if (updateErr) {
          results.push({
            sku: product.sku,
            status: "error",
            reason: `DB update failed: ${updateErr.message}`,
          });
        } else {
          results.push({
            sku: product.sku,
            status: "migrated",
            imageCount: newImageUrls.length,
          });
        }
      } else {
        results.push({
          sku: product.sku,
          status: "no_images_downloaded",
          reason: "Could not download any images from WooCommerce",
        });
      }
    }

    const migrated = results.filter((r) => r.status === "migrated").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const errors = results.filter((r) =>
      ["error", "no_woo_images", "no_images_downloaded"].includes(r.status)
    ).length;

    return new Response(
      JSON.stringify({
        success: true,
        summary: {
          processed: productsWithStorageImages.length,
          migrated,
          skipped,
          errors,
          nextOffset: offset + batchSize,
        },
        results,
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
