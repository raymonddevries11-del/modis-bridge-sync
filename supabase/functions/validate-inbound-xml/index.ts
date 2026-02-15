// Inbound XML Auto-Validator v1 — validates all Modis bridge XML types
// Detects file type, validates structure/fields, logs results to xml_validation_logs
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Schema definitions per file type ────────────────────────────────
// These define required/optional elements and their expected data types

interface FieldSchema {
  name: string;
  required: boolean;
  type: "string" | "number" | "sku" | "date" | "boolean" | "enum";
  enumValues?: string[];
  maxLength?: number;
}

interface XmlSchema {
  fileType: string;
  rootElement: string;
  itemElement: string;
  fields: FieldSchema[];
}

const STOCK_INCREMENTAL_SCHEMA: XmlSchema = {
  fileType: "stock",
  rootElement: "", // flexible root
  itemElement: "vrd",
  fields: [
    { name: "artikelnummer", required: true, type: "sku" },
    { name: "mutatiecode", required: false, type: "string", maxLength: 10 },
    { name: "verkoopprijs", required: false, type: "number" },
    { name: "lopende-verkoopprijs", required: false, type: "number" },
    { name: "maat", required: false, type: "string" },
    { name: "maat-id", required: false, type: "string" },
    { name: "aantal", required: false, type: "number" },
  ],
};

const STOCK_FULL_SCHEMA: XmlSchema = {
  fileType: "stock-full",
  rootElement: "",
  itemElement: "vrd",
  fields: [
    { name: "artikelnummer", required: true, type: "sku" },
    { name: "totaal-aantal", required: true, type: "number" },
    { name: "maat", required: false, type: "string" },
    { name: "maat-id", required: false, type: "string" },
  ],
};

const ARTICLE_SCHEMA: XmlSchema = {
  fileType: "article",
  rootElement: "",
  itemElement: "artikel",
  fields: [
    { name: "artikelnummer", required: true, type: "sku" },
    { name: "webshop-titel", required: true, type: "string", maxLength: 500 },
    { name: "verkoopprijs", required: false, type: "number" },
    { name: "merk", required: false, type: "string" },
    { name: "merk-oms", required: false, type: "string" },
    { name: "artikelgroep", required: false, type: "string" },
    { name: "kleur", required: false, type: "string" },
    { name: "kleur-oms", required: false, type: "string" },
    { name: "foto-01", required: false, type: "string" },
    { name: "maat", required: false, type: "string" },
    { name: "maat-id", required: false, type: "string" },
    { name: "ean", required: false, type: "string" },
    { name: "webshop-tekst", required: false, type: "string" },
    { name: "attribuut-nm-1", required: false, type: "string" },
    { name: "attribuut-waarde-1", required: false, type: "string" },
  ],
};

// ── Detect file type from filename and content ──────────────────────
function detectFileType(
  fileName: string,
  itemCounts: { vrd: number; artikel: number }
): { schema: XmlSchema; confidence: string } {
  const fn = fileName.toLowerCase();

  // Article files
  if (fn.includes("artikel") || fn.includes("article") || itemCounts.artikel > 0) {
    return { schema: ARTICLE_SCHEMA, confidence: "high" };
  }

  // Full stock files (totale-vrd or volledig)
  if (fn.includes("volledig") || fn.includes("totale-vrd") || fn.includes("full")) {
    return { schema: STOCK_FULL_SCHEMA, confidence: "high" };
  }

  // Incremental stock files
  if (fn.includes("vrd") || fn.includes("stock") || fn.includes("voorraad") || itemCounts.vrd > 0) {
    return { schema: STOCK_INCREMENTAL_SCHEMA, confidence: "high" };
  }

  // Fallback: try to detect from content
  if (itemCounts.vrd > 0) {
    return { schema: STOCK_INCREMENTAL_SCHEMA, confidence: "medium" };
  }

  return { schema: STOCK_INCREMENTAL_SCHEMA, confidence: "low" };
}

// ── Simple XML tag extractor (no external parser needed) ────────────
function extractElements(xml: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

function extractChildValue(itemXml: string, childTag: string): string | null {
  const regex = new RegExp(`<${childTag}[^>]*>([^<]*)<\\/${childTag}>`, "i");
  const match = itemXml.match(regex);
  return match ? match[1].trim() : null;
}

function countTags(xml: string, tagName: string): number {
  const regex = new RegExp(`<${tagName}[\\s>]`, "gi");
  const matches = xml.match(regex);
  return matches ? matches.length : 0;
}

// ── Field validation ────────────────────────────────────────────────
interface ValidationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
  itemIndex?: number;
  sku?: string;
}

function validateField(
  value: string | null,
  field: FieldSchema,
  itemIndex: number,
  sku: string | null
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const context = { itemIndex, sku: sku || undefined };

  if (field.required && (!value || value.trim() === "")) {
    issues.push({
      level: "error",
      field: field.name,
      message: `Verplicht veld '${field.name}' ontbreekt of is leeg`,
      ...context,
    });
    return issues;
  }

  if (!value || value.trim() === "") return issues;

  const trimmed = value.trim();

  switch (field.type) {
    case "sku":
      if (!/^\d+$/.test(trimmed.replace(/\D/g, ""))) {
        issues.push({
          level: "warning",
          field: field.name,
          message: `SKU '${trimmed}' bevat onverwachte tekens`,
          ...context,
        });
      }
      break;

    case "number": {
      const num = parseFloat(trimmed.replace(",", "."));
      if (isNaN(num)) {
        issues.push({
          level: "error",
          field: field.name,
          message: `Ongeldige numerieke waarde '${trimmed}'`,
          ...context,
        });
      } else if (num < 0) {
        issues.push({
          level: "warning",
          field: field.name,
          message: `Negatieve waarde ${num} voor '${field.name}'`,
          ...context,
        });
      }
      break;
    }

    case "enum":
      if (field.enumValues && !field.enumValues.includes(trimmed)) {
        issues.push({
          level: "warning",
          field: field.name,
          message: `Waarde '${trimmed}' niet in toegestane lijst: ${field.enumValues.join(", ")}`,
          ...context,
        });
      }
      break;

    case "string":
      if (field.maxLength && trimmed.length > field.maxLength) {
        issues.push({
          level: "warning",
          field: field.name,
          message: `Waarde voor '${field.name}' is ${trimmed.length} tekens (max ${field.maxLength})`,
          ...context,
        });
      }
      break;
  }

  return issues;
}

// ── Main handler ────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { fileName, xmlContent, xmlUrl, tenantId } = await req.json();

    if (!tenantId) {
      return new Response(JSON.stringify({ error: "Missing tenantId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Fetch XML if URL provided ─────────────────────────────────
    let xml = xmlContent || "";
    let actualFileName = fileName || "unknown.xml";

    if (xmlUrl && !xmlContent) {
      console.log(`Fetching XML from: ${xmlUrl}`);
      const resp = await fetch(xmlUrl);
      if (!resp.ok) throw new Error(`Failed to fetch XML: ${resp.status}`);
      xml = await resp.text();
      actualFileName = fileName || xmlUrl.split("/").pop() || "unknown.xml";
    }

    if (!xml || xml.trim().length === 0) {
      return new Response(JSON.stringify({ error: "No XML content provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fileSize = new Blob([xml]).size;
    console.log(`Validating '${actualFileName}' (${fileSize} bytes)`);

    // ── Step 1: Basic XML well-formedness ─────────────────────────
    const allErrors: ValidationIssue[] = [];
    const allWarnings: ValidationIssue[] = [];

    // Check XML declaration
    if (!xml.trimStart().startsWith("<?xml") && !xml.trimStart().startsWith("<")) {
      allErrors.push({ level: "error", field: "_xml", message: "Bestand begint niet met geldige XML" });
    }

    // Check balanced tags (basic)
    const openTags = (xml.match(/<[a-zA-Z][^/]*?>/g) || []).length;
    const closeTags = (xml.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
    const selfClosing = (xml.match(/<[^>]*\/>/g) || []).length;
    if (Math.abs(openTags - closeTags - selfClosing) > openTags * 0.1) {
      allWarnings.push({
        level: "warning",
        field: "_xml",
        message: `Mogelijk onevenwichtige XML tags (open: ${openTags}, close: ${closeTags}, self-closing: ${selfClosing})`,
      });
    }

    // ── Step 2: Detect file type ──────────────────────────────────
    const vrdCount = countTags(xml, "vrd");
    const artikelCount = countTags(xml, "artikel");
    const { schema, confidence } = detectFileType(actualFileName, {
      vrd: vrdCount,
      artikel: artikelCount,
    });

    console.log(`Detected type: ${schema.fileType} (confidence: ${confidence}), items: ${schema.itemElement === "vrd" ? vrdCount : artikelCount}`);

    if (confidence === "low") {
      allWarnings.push({
        level: "warning",
        field: "_type",
        message: `Bestandstype kon niet zeker worden bepaald (gok: ${schema.fileType})`,
      });
    }

    // ── Step 3: Extract and validate items ────────────────────────
    const items = extractElements(xml, schema.itemElement);
    const itemCount = items.length;

    if (itemCount === 0) {
      allErrors.push({
        level: "error",
        field: schema.itemElement,
        message: `Geen <${schema.itemElement}> elementen gevonden in XML`,
      });
    }

    // Track field coverage stats
    const fieldPresence: Record<string, number> = {};
    const uniqueSkus = new Set<string>();
    const duplicateSkuMaatPairs: string[] = [];
    const seenSkuMaat = new Set<string>();

    // Validate a sample of items (all if < 500, else first 200 + last 100)
    const sampleIndices: number[] = [];
    if (itemCount <= 500) {
      for (let i = 0; i < itemCount; i++) sampleIndices.push(i);
    } else {
      for (let i = 0; i < 200; i++) sampleIndices.push(i);
      for (let i = itemCount - 100; i < itemCount; i++) sampleIndices.push(i);
    }

    for (const idx of sampleIndices) {
      const itemXml = items[idx];
      const sku = extractChildValue(itemXml, "artikelnummer");

      if (sku) uniqueSkus.add(sku.replace(/\D/g, ""));

      // Check for duplicate SKU + maat combinations
      const maatId = extractChildValue(itemXml, "maat-id");
      if (sku && maatId) {
        const key = `${sku}-${maatId}`;
        if (seenSkuMaat.has(key)) {
          duplicateSkuMaatPairs.push(key);
        }
        seenSkuMaat.add(key);
      }

      // Validate each field in schema
      for (const field of schema.fields) {
        const value = extractChildValue(itemXml, field.name);
        if (value !== null) {
          fieldPresence[field.name] = (fieldPresence[field.name] || 0) + 1;
        }
        const issues = validateField(value, field, idx, sku);
        for (const issue of issues) {
          if (issue.level === "error") allErrors.push(issue);
          else allWarnings.push(issue);
        }
      }

      // Discover extra fields not in schema (first 10 items only)
      if (idx < 10) {
        const allChildTags = itemXml.match(/<([a-zA-Z][\w-]*)\b[^>]*>/g) || [];
        for (const tag of allChildTags) {
          const tagName = tag.replace(/<([a-zA-Z][\w-]*)\b.*/, "$1");
          if (!schema.fields.find((f) => f.name === tagName)) {
            fieldPresence[`_extra:${tagName}`] = (fieldPresence[`_extra:${tagName}`] || 0) + 1;
          }
        }
      }
    }

    // Duplicate warnings (cap at 20)
    if (duplicateSkuMaatPairs.length > 0) {
      allWarnings.push({
        level: "warning",
        field: "artikelnummer+maat-id",
        message: `${duplicateSkuMaatPairs.length} dubbele SKU+maat combinaties gevonden (eerste: ${duplicateSkuMaatPairs.slice(0, 5).join(", ")})`,
      });
    }

    // ── Step 4: Compile stats ─────────────────────────────────────
    // Cap error/warning arrays to prevent oversized DB rows
    const cappedErrors = allErrors.slice(0, 100);
    const cappedWarnings = allWarnings.slice(0, 100);
    const isValid = allErrors.length === 0;

    const stats = {
      item_count: itemCount,
      unique_skus: uniqueSkus.size,
      duplicate_sku_maat_pairs: duplicateSkuMaatPairs.length,
      detected_type: schema.fileType,
      detection_confidence: confidence,
      sampled_items: sampleIndices.length,
      field_coverage: Object.fromEntries(
        Object.entries(fieldPresence)
          .filter(([k]) => !k.startsWith("_extra:"))
          .map(([k, v]) => [k, `${v}/${sampleIndices.length}`])
      ),
      extra_fields: Object.entries(fieldPresence)
        .filter(([k]) => k.startsWith("_extra:"))
        .map(([k]) => k.replace("_extra:", "")),
      total_errors: allErrors.length,
      total_warnings: allWarnings.length,
    };

    console.log(
      `Validation result: ${isValid ? "VALID" : "INVALID"} | ${allErrors.length} errors, ${allWarnings.length} warnings | ${itemCount} items, ${uniqueSkus.size} unique SKUs`
    );

    // ── Step 5: Upsert to DB ──────────────────────────────────────
    const { error: dbError } = await supabase.from("xml_validation_logs").insert({
      tenant_id: tenantId,
      file_name: actualFileName,
      file_type: schema.fileType,
      file_size: fileSize,
      is_valid: isValid,
      errors: cappedErrors,
      warnings: cappedWarnings,
      stats,
    });

    if (dbError) {
      console.error("Failed to save validation log:", dbError.message);
    }

    return new Response(
      JSON.stringify({
        valid: isValid,
        fileType: schema.fileType,
        confidence,
        itemCount,
        uniqueSkus: uniqueSkus.size,
        errors: cappedErrors,
        warnings: cappedWarnings,
        stats,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Validation error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
