import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Real-time image existence verifier.
 * Checks every product image URL against storage bucket files and returns:
 * - missing: URL points to a file not in storage
 * - case_mismatch: URL casing differs from actual storage file
 * - ok: URL matches a storage file exactly
 * - external: URL points outside storage
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
  const tenant = body.tenant ?? "kosterschoenmode";
  const limit = Math.min(body.limit ?? 100, 500);
  const offset = body.offset ?? 0;
  const filterStatus = body.filterStatus; // "missing" | "case_mismatch" | "external" | null

  try {
    const { data: tenantRow } = await supabase
      .from("tenants").select("id").eq("slug", tenant).single();
    if (!tenantRow) throw new Error("Tenant not found");

    // Build storage index
    const storageIndex = new Map<string, string>(); // lowercase → actual path
    for (const prefix of ["", "modis/foto"]) {
      let off = 0;
      while (true) {
        const { data: files, error } = await supabase.storage
          .from("product-images")
          .list(prefix, { limit: 1000, offset: off, sortBy: { column: "name", order: "asc" } });
        if (error || !files || files.length === 0) break;
        for (const f of files) {
          if (!f.name || f.id === null) continue;
          const fullPath = prefix ? `${prefix}/${f.name}` : f.name;
          storageIndex.set(fullPath.toLowerCase(), fullPath);
        }
        if (files.length < 1000) break;
        off += 1000;
      }
    }

    // Fetch products
    const { data: products, error } = await supabase
      .from("products")
      .select("id, sku, title, images")
      .eq("tenant_id", tenantRow.id)
      .not("images", "is", null)
      .order("sku")
      .range(offset, offset + limit - 1);

    if (error) throw error;

    interface UrlResult {
      url: string;
      status: "ok" | "missing" | "case_mismatch" | "external";
      storagePath?: string;
      suggestion?: string;
    }

    interface ProductResult {
      id: string;
      sku: string;
      title: string;
      urls: UrlResult[];
      summary: { ok: number; missing: number; case_mismatch: number; external: number };
    }

    const results: ProductResult[] = [];
    let totalOk = 0, totalMissing = 0, totalCaseMismatch = 0, totalExternal = 0;

    for (const prod of products || []) {
      if (!Array.isArray(prod.images) || prod.images.length === 0) continue;

      const urls: UrlResult[] = [];
      const summary = { ok: 0, missing: 0, case_mismatch: 0, external: 0 };

      for (const rawUrl of prod.images as string[]) {
        if (typeof rawUrl !== "string" || !rawUrl.trim()) continue;
        const url = rawUrl.trim();

        // External URL
        if (!url.includes("/product-images/") && !url.startsWith("modis/")) {
          if (url.startsWith("http") && !url.includes("supabase.co")) {
            urls.push({ url, status: "external" });
            summary.external++; totalExternal++;
            continue;
          }
        }

        // Extract path in bucket
        let pathInBucket: string;
        if (url.includes("/product-images/")) {
          pathInBucket = url.replace(/^.*\/product-images\//, "");
        } else {
          pathInBucket = url.replace(/\\/g, "/");
        }

        const lowerKey = pathInBucket.toLowerCase();

        // Try exact match
        const actualPath = storageIndex.get(lowerKey);

        if (!actualPath) {
          // Try without modis/foto prefix or with it
          const stripped = lowerKey.replace(/^modis\/foto\//, "");
          const altActual = storageIndex.get(stripped) || storageIndex.get(`modis/foto/${stripped}`);

          if (altActual) {
            urls.push({ url, status: "case_mismatch", storagePath: altActual, suggestion: altActual });
            summary.case_mismatch++; totalCaseMismatch++;
          } else {
            urls.push({ url, status: "missing" });
            summary.missing++; totalMissing++;
          }
        } else if (actualPath === pathInBucket) {
          urls.push({ url, status: "ok", storagePath: actualPath });
          summary.ok++; totalOk++;
        } else {
          urls.push({ url, status: "case_mismatch", storagePath: actualPath, suggestion: actualPath });
          summary.case_mismatch++; totalCaseMismatch++;
        }
      }

      // Apply filter
      const hasIssue = filterStatus
        ? urls.some(u => u.status === filterStatus)
        : urls.some(u => u.status !== "ok");

      if (!filterStatus || hasIssue) {
        results.push({ id: prod.id, sku: prod.sku, title: prod.title, urls, summary });
      }
    }

    return new Response(JSON.stringify({
      storageFilesIndexed: storageIndex.size,
      productsScanned: products?.length ?? 0,
      offset,
      limit,
      totals: { ok: totalOk, missing: totalMissing, case_mismatch: totalCaseMismatch, external: totalExternal },
      products: results,
    }), {
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
