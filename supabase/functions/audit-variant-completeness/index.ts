import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { tenantId } = await req.json();
    if (!tenantId) {
      return new Response(JSON.stringify({ error: "tenantId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all products with article_group for sneaker detection
    const allProducts: any[] = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("products")
        .select("id, sku, title, article_group, attributes, images")
        .eq("tenant_id", tenantId)
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allProducts.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }

    // Fetch all variants
    const productIds = allProducts.map((p) => p.id);
    const variantsByProduct = new Map<string, any[]>();

    for (let i = 0; i < productIds.length; i += 100) {
      const batch = productIds.slice(i, i + 100);
      const { data: variants } = await supabase
        .from("variants")
        .select("id, product_id, maat_id, size_label, maat_web, ean, active")
        .in("product_id", batch);
      for (const v of variants || []) {
        if (!variantsByProduct.has(v.product_id)) {
          variantsByProduct.set(v.product_id, []);
        }
        variantsByProduct.get(v.product_id)!.push(v);
      }
    }

    // Detect sneaker-like products by article_group description
    const sneakerKeywords = [
      "sneaker",
      "schoen",
      "shoe",
      "boot",
      "laars",
      "sandal",
      "slipper",
      "pump",
      "loafer",
      "denver",
    ];

    const isSneakerLike = (p: any): boolean => {
      const desc = (
        p.article_group?.description ||
        p.article_group?.name ||
        p.title ||
        ""
      ).toLowerCase();
      return sneakerKeywords.some((kw) => desc.includes(kw));
    };

    interface AuditIssue {
      sku: string;
      title: string;
      productId: string;
      isSneaker: boolean;
      issues: string[];
      variantCount: number;
      activeVariantCount: number;
      missingMaatIds: string[];
      missingEans: string[];
      missingSizeLabels: string[];
    }

    const auditResults: AuditIssue[] = [];

    for (const product of allProducts) {
      const variants = variantsByProduct.get(product.id) || [];
      const sneaker = isSneakerLike(product);
      const issues: string[] = [];
      const missingMaatIds: string[] = [];
      const missingEans: string[] = [];
      const missingSizeLabels: string[] = [];
      const activeVariants = variants.filter((v) => v.active);

      // Issue 1: No variants at all
      if (variants.length === 0) {
        issues.push("Geen varianten gevonden");
      }

      // Issue 2: Very few variants for sneaker products (expect >= 5 sizes)
      if (sneaker && activeVariants.length > 0 && activeVariants.length < 3) {
        issues.push(
          `Slechts ${activeVariants.length} actieve maten (verwacht ≥3 voor schoenen)`
        );
      }

      // Issue 3: Check each variant for missing data
      for (const v of variants) {
        // maat_id still in old format (contains hyphen = legacy SKU-size format)
        if (!v.maat_id || v.maat_id.includes("-")) {
          missingMaatIds.push(v.size_label || v.maat_id || "?");
        }
        // Missing EAN
        if (!v.ean) {
          missingEans.push(v.size_label || v.maat_id || "?");
        }
        // Missing size_label
        if (!v.size_label || v.size_label === v.maat_id) {
          missingSizeLabels.push(v.maat_id || "?");
        }
        // Missing maat_web
      }

      if (missingMaatIds.length > 0) {
        issues.push(
          `${missingMaatIds.length} variant(en) met ontbrekend/legacy maat_id`
        );
      }
      if (missingEans.length > 0) {
        issues.push(`${missingEans.length} variant(en) zonder EAN`);
      }

      if (issues.length > 0) {
        auditResults.push({
          sku: product.sku,
          title: product.title,
          productId: product.id,
          isSneaker: sneaker,
          issues,
          variantCount: variants.length,
          activeVariantCount: activeVariants.length,
          missingMaatIds,
          missingEans,
          missingSizeLabels,
        });
      }
    }

    // Sort: sneakers first, then by issue count descending
    auditResults.sort((a, b) => {
      if (a.isSneaker !== b.isSneaker) return a.isSneaker ? -1 : 1;
      if (a.variantCount === 0 && b.variantCount > 0) return -1;
      if (b.variantCount === 0 && a.variantCount > 0) return 1;
      return b.issues.length - a.issues.length;
    });

    // Summary stats
    const summary = {
      totalProducts: allProducts.length,
      productsWithIssues: auditResults.length,
      noVariants: auditResults.filter((r) => r.variantCount === 0).length,
      legacyMaatIds: auditResults.filter((r) => r.missingMaatIds.length > 0)
        .length,
      missingEans: auditResults.filter((r) => r.missingEans.length > 0).length,
      sneakerIssues: auditResults.filter((r) => r.isSneaker).length,
    };

    return new Response(
      JSON.stringify({
        success: true,
        summary,
        issues: auditResults.slice(0, 200), // cap at 200
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("audit-variant-completeness error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
