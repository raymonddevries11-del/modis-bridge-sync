// Inbound XML Auto-Validator v2 — XSD-like structural validation for Modis bridge XML
// Validates element hierarchy, cardinality, data types, and logs results to xml_validation_logs
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── XSD-like Schema Definitions ─────────────────────────────────────
// These mirror W3C XSD concepts: element hierarchy, minOccurs/maxOccurs,
// data types (xs:string, xs:decimal, xs:integer, xs:boolean), and patterns.

interface XsdElement {
  name: string;
  type: "string" | "decimal" | "integer" | "boolean" | "sku" | "date";
  minOccurs: number;      // 0 = optional, 1 = required
  maxOccurs: number | "unbounded";
  maxLength?: number;
  pattern?: RegExp;       // xs:pattern equivalent
  enumeration?: string[]; // xs:enumeration equivalent
  children?: XsdElement[];
}

interface XsdSchema {
  fileType: string;
  rootElement: string;    // "" = flexible root (Modis doesn't always use consistent roots)
  itemElement: string;
  itemSchema: XsdElement[];
}

// ── Article XSD Schema ──────────────────────────────────────────────
const ARTICLE_XSD: XsdSchema = {
  fileType: "article",
  rootElement: "",
  itemElement: "artikel",
  itemSchema: [
    { name: "artikelnummer", type: "sku", minOccurs: 1, maxOccurs: 1, pattern: /^\d+$/ },
    { name: "webshop-titel", type: "string", minOccurs: 1, maxOccurs: 1, maxLength: 500 },
    { name: "verkoopprijs", type: "decimal", minOccurs: 0, maxOccurs: 1 },
    { name: "lopende-verkoopprijs", type: "decimal", minOccurs: 0, maxOccurs: 1 },
    { name: "kostprijs", type: "decimal", minOccurs: 0, maxOccurs: 1 },
    { name: "btw-code", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "url-sleutel", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "kortings-percentage", type: "decimal", minOccurs: 0, maxOccurs: 1 },
    { name: "interne-omschrijving", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "webshop-tekst", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "webshop-tekst-en", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "meta-titel-1", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "meta-keywords-1", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "meta-oms-1", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "planperiode", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "outlet-sale", type: "boolean", minOccurs: 0, maxOccurs: 1, enumeration: ["0", "1"] },
    { name: "aanbieding", type: "boolean", minOccurs: 0, maxOccurs: 1, enumeration: ["0", "1"] },
    { name: "webshopdatum", type: "date", minOccurs: 0, maxOccurs: 1 },
    { name: "kleur", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "kleur-oms", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "kleur-oms-lev", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "kleur-web", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "webfilter-kleur", type: "string", minOccurs: 0, maxOccurs: 1 },
    // Photo elements (foto-01 through foto-06)
    { name: "foto-01", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "foto-02", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "foto-03", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "foto-04", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "foto-05", type: "string", minOccurs: 0, maxOccurs: 1 },
    { name: "foto-06", type: "string", minOccurs: 0, maxOccurs: 1 },
    // Brand (nested element — merknaam optional since Modis sometimes uses flat <merk>)
    {
      name: "merk", type: "string", minOccurs: 0, maxOccurs: 1,
      children: [
        { name: "merknaam", type: "string", minOccurs: 0, maxOccurs: 1 },
      ],
    },
    // Supplier (nested — naam-leverancier optional since Modis sometimes uses flat <leverancier>)
    {
      name: "leverancier", type: "string", minOccurs: 0, maxOccurs: 1,
      children: [
        { name: "naam-leverancier", type: "string", minOccurs: 0, maxOccurs: 1 },
      ],
    },
    // Artikelgroep (nested with attribute)
    {
      name: "artikelgroep", type: "string", minOccurs: 0, maxOccurs: 1,
      children: [
        { name: "omschrijving", type: "string", minOccurs: 0, maxOccurs: 1 },
      ],
    },
    // Maten container with maat children
    {
      name: "maten", type: "string", minOccurs: 0, maxOccurs: 1,
      children: [
        {
          name: "maat", type: "string", minOccurs: 1, maxOccurs: "unbounded",
          children: [
            { name: "maat-alfa", type: "string", minOccurs: 1, maxOccurs: 1 },
            { name: "maat-web", type: "string", minOccurs: 0, maxOccurs: 1 },
            { name: "ean-barcode", type: "string", minOccurs: 0, maxOccurs: 1 },
            { name: "maat-actief", type: "boolean", minOccurs: 0, maxOccurs: 1, enumeration: ["0", "1"] },
            {
              name: "voorraad", type: "string", minOccurs: 0, maxOccurs: 1,
              children: [
                { name: "totaal-aantal", type: "integer", minOccurs: 0, maxOccurs: 1 },
                {
                  name: "filialen", type: "string", minOccurs: 0, maxOccurs: 1,
                  children: [
                    {
                      name: "filiaal", type: "string", minOccurs: 0, maxOccurs: "unbounded",
                      children: [
                        { name: "Aantal", type: "integer", minOccurs: 1, maxOccurs: 1 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // Attribute pairs (1-20)
    ...Array.from({ length: 20 }, (_, i) => [
      { name: `attribuut-nm-${i + 1}`, type: "string" as const, minOccurs: 0, maxOccurs: 1 },
      { name: `attribuut-waarde-${i + 1}`, type: "string" as const, minOccurs: 0, maxOccurs: 1 },
      { name: `attribuut-waarde-oms-${i + 1}`, type: "string" as const, minOccurs: 0, maxOccurs: 1 },
    ]).flat(),
    // Webshop groups (1-8)
    ...Array.from({ length: 8 }, (_, i) => [
      { name: `webshop-groep-${i + 1}`, type: "string" as const, minOccurs: 0, maxOccurs: 1 },
      { name: `wgp-omschrijving-${i + 1}`, type: "string" as const, minOccurs: 0, maxOccurs: 1 },
    ]).flat(),
  ],
};

// ── Stock Incremental XSD Schema ────────────────────────────────────
const STOCK_INCREMENTAL_XSD: XsdSchema = {
  fileType: "stock",
  rootElement: "",
  itemElement: "vrd",
  itemSchema: [
    { name: "artikelnummer", type: "sku", minOccurs: 1, maxOccurs: 1, pattern: /^\d+$/ },
    { name: "mutatiecode", type: "string", minOccurs: 0, maxOccurs: 1, maxLength: 10, enumeration: ["I", "U", "D"] },
    { name: "verkoopprijs", type: "decimal", minOccurs: 0, maxOccurs: 1 },
    { name: "lopende-verkoopprijs", type: "decimal", minOccurs: 0, maxOccurs: 1 },
    {
      name: "maat", type: "string", minOccurs: 0, maxOccurs: "unbounded",
      children: [
        { name: "ean-barcode", type: "string", minOccurs: 0, maxOccurs: 1 },
        { name: "totaal-aantal", type: "integer", minOccurs: 1, maxOccurs: 1 },
        {
          name: "filialen", type: "string", minOccurs: 0, maxOccurs: 1,
          children: [
            {
              name: "filiaal", type: "string", minOccurs: 0, maxOccurs: "unbounded",
              children: [
                { name: "Aantal", type: "integer", minOccurs: 1, maxOccurs: 1 },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ── Stock Full XSD Schema ───────────────────────────────────────────
const STOCK_FULL_XSD: XsdSchema = {
  fileType: "stock-full",
  rootElement: "",
  itemElement: "vrd",
  itemSchema: [
    { name: "artikelnummer", type: "sku", minOccurs: 1, maxOccurs: 1, pattern: /^\d+$/ },
    { name: "totaal-aantal", type: "integer", minOccurs: 1, maxOccurs: 1 },
    {
      name: "maat", type: "string", minOccurs: 0, maxOccurs: "unbounded",
      children: [
        { name: "maat-id", type: "string", minOccurs: 0, maxOccurs: 1 },
        { name: "totaal-aantal", type: "integer", minOccurs: 0, maxOccurs: 1 },
      ],
    },
  ],
};

// ── Detect file type from filename and content ──────────────────────
function detectFileType(
  fileName: string,
  itemCounts: { vrd: number; artikel: number }
): { schema: XsdSchema; confidence: string } {
  const fn = fileName.toLowerCase();

  if (fn.includes("artikel") || fn.includes("article") || itemCounts.artikel > 0) {
    return { schema: ARTICLE_XSD, confidence: "high" };
  }
  if (fn.includes("volledig") || fn.includes("totale-vrd") || fn.includes("full")) {
    return { schema: STOCK_FULL_XSD, confidence: "high" };
  }
  if (fn.includes("vrd") || fn.includes("stock") || fn.includes("voorraad") || itemCounts.vrd > 0) {
    return { schema: STOCK_INCREMENTAL_XSD, confidence: "high" };
  }
  if (itemCounts.vrd > 0) {
    return { schema: STOCK_INCREMENTAL_XSD, confidence: "medium" };
  }
  return { schema: STOCK_INCREMENTAL_XSD, confidence: "low" };
}

// ── Simple XML helpers (no external parser needed) ──────────────────
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
  return (xml.match(regex) || []).length;
}

function countDirectChildren(parentXml: string, childTag: string): number {
  // Count occurrences of opening tag within this parent context
  const regex = new RegExp(`<${childTag}[\\s>]`, "gi");
  return (parentXml.match(regex) || []).length;
}

function hasChildElement(parentXml: string, childTag: string): boolean {
  const regex = new RegExp(`<${childTag}[\\s>]`, "i");
  return regex.test(parentXml);
}

// ── XSD Structural Validation Engine ────────────────────────────────
interface ValidationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
  itemIndex?: number;
  sku?: string;
  xsdRule?: string;  // Which XSD constraint was violated
}

function validateXsdType(
  value: string,
  element: XsdElement,
): ValidationIssue | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  switch (element.type) {
    case "sku":
      if (element.pattern && !element.pattern.test(trimmed.replace(/\D/g, ""))) {
        return {
          level: "warning",
          field: element.name,
          message: `SKU '${trimmed}' bevat onverwachte tekens (xs:pattern violation)`,
          xsdRule: "xs:pattern",
        };
      }
      break;

    case "decimal": {
      const num = parseFloat(trimmed.replace(",", "."));
      if (isNaN(num)) {
        return {
          level: "error",
          field: element.name,
          message: `Ongeldige xs:decimal waarde '${trimmed}'`,
          xsdRule: "xs:decimal",
        };
      }
      if (num < 0) {
        return {
          level: "warning",
          field: element.name,
          message: `Negatieve xs:decimal waarde ${num} voor '${element.name}'`,
          xsdRule: "xs:decimal",
        };
      }
      break;
    }

    case "integer": {
      const intVal = parseInt(trimmed.replace(/^0+/, "") || "0", 10);
      if (isNaN(intVal)) {
        return {
          level: "error",
          field: element.name,
          message: `Ongeldige xs:integer waarde '${trimmed}'`,
          xsdRule: "xs:integer",
        };
      }
      break;
    }

    case "boolean":
      if (element.enumeration && !element.enumeration.includes(trimmed)) {
        return {
          level: "warning",
          field: element.name,
          message: `Waarde '${trimmed}' niet geldig voor boolean veld (verwacht: ${element.enumeration.join(", ")})`,
          xsdRule: "xs:enumeration",
        };
      }
      break;

    case "string":
      if (element.maxLength && trimmed.length > element.maxLength) {
        return {
          level: "warning",
          field: element.name,
          message: `Waarde voor '${element.name}' is ${trimmed.length} tekens (xs:maxLength ${element.maxLength})`,
          xsdRule: "xs:maxLength",
        };
      }
      if (element.enumeration && !element.enumeration.includes(trimmed)) {
        return {
          level: "warning",
          field: element.name,
          message: `Waarde '${trimmed}' niet in xs:enumeration: ${element.enumeration.join(", ")}`,
          xsdRule: "xs:enumeration",
        };
      }
      break;

    case "date":
      // Basic date format check (YYYY-MM-DD or DD-MM-YYYY or YYYYMMDD)
      if (!/^\d{4}[-/]?\d{2}[-/]?\d{2}$/.test(trimmed) && !/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(trimmed)) {
        return {
          level: "warning",
          field: element.name,
          message: `Waarde '${trimmed}' is geen geldig xs:date formaat`,
          xsdRule: "xs:date",
        };
      }
      break;
  }

  return null;
}

function validateItemAgainstXsd(
  itemXml: string,
  schema: XsdElement[],
  itemIndex: number,
  sku: string | null,
  parentPath = ""
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const context = { itemIndex, sku: sku || undefined };

  for (const element of schema) {
    // Skip generated attribute/group fields (they're optional structural elements)
    const fullPath = parentPath ? `${parentPath}/${element.name}` : element.name;

    // Check cardinality (minOccurs / maxOccurs)
    const occurrences = countDirectChildren(itemXml, element.name);

    if (element.minOccurs > 0 && occurrences === 0) {
      // Check if value exists as text content (flat element)
      const value = extractChildValue(itemXml, element.name);
      if (!value || value.trim() === "") {
        issues.push({
          level: "error",
          field: fullPath,
          message: `Verplicht element <${element.name}> ontbreekt (minOccurs=${element.minOccurs})`,
          xsdRule: "minOccurs",
          ...context,
        });
        continue;
      }
    }

    if (element.maxOccurs !== "unbounded" && occurrences > element.maxOccurs) {
      issues.push({
        level: "warning",
        field: fullPath,
        message: `Element <${element.name}> komt ${occurrences}x voor (maxOccurs=${element.maxOccurs})`,
        xsdRule: "maxOccurs",
        ...context,
      });
    }

    // Type validation for leaf elements
    if (!element.children) {
      const value = extractChildValue(itemXml, element.name);
      if (value && value.trim()) {
        const typeIssue = validateXsdType(value, element);
        if (typeIssue) {
          issues.push({ ...typeIssue, ...context });
        }
      }
    }

    // Recursive child validation for complex elements
    if (element.children && hasChildElement(itemXml, element.name)) {
      const childContents = extractElements(itemXml, element.name);
      for (const childXml of childContents) {
        const childIssues = validateItemAgainstXsd(
          childXml,
          element.children,
          itemIndex,
          sku,
          fullPath
        );
        issues.push(...childIssues);
      }
    }
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
    const { fileName, xmlContent, xmlUrl, tenantId, strict } = await req.json();

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
    console.log(`XSD Validating '${actualFileName}' (${fileSize} bytes, strict=${!!strict})`);

    // ── Step 1: Basic XML well-formedness ─────────────────────────
    const allErrors: ValidationIssue[] = [];
    const allWarnings: ValidationIssue[] = [];

    if (!xml.trimStart().startsWith("<?xml") && !xml.trimStart().startsWith("<")) {
      allErrors.push({ level: "error", field: "_xml", message: "Bestand begint niet met geldige XML", xsdRule: "well-formed" });
    }

    // Balanced tags check
    const openTags = (xml.match(/<[a-zA-Z][^/]*?>/g) || []).length;
    const closeTags = (xml.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
    const selfClosing = (xml.match(/<[^>]*\/>/g) || []).length;
    if (Math.abs(openTags - closeTags - selfClosing) > openTags * 0.1) {
      allWarnings.push({
        level: "warning",
        field: "_xml",
        message: `Mogelijk onevenwichtige XML tags (open: ${openTags}, close: ${closeTags}, self-closing: ${selfClosing})`,
        xsdRule: "well-formed",
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
        xsdRule: "type-detection",
      });
    }

    // ── Step 3: Extract items and validate against XSD ────────────
    const items = extractElements(xml, schema.itemElement);
    const itemCount = items.length;

    if (itemCount === 0) {
      allErrors.push({
        level: "error",
        field: schema.itemElement,
        message: `Geen <${schema.itemElement}> elementen gevonden in XML`,
        xsdRule: "minOccurs",
      });
    }

    // Track stats
    const fieldPresence: Record<string, number> = {};
    const uniqueSkus = new Set<string>();
    const duplicateSkuMaatPairs: string[] = [];
    const seenSkuMaat = new Set<string>();
    let xsdErrorCount = 0;
    let xsdWarningCount = 0;

    // Sample strategy: all if < 500, else first 200 + last 100
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

      // Duplicate SKU+maat check
      const maatId = extractChildValue(itemXml, "maat-id");
      if (sku && maatId) {
        const key = `${sku}-${maatId}`;
        if (seenSkuMaat.has(key)) {
          duplicateSkuMaatPairs.push(key);
        }
        seenSkuMaat.add(key);
      }

      // ── XSD structural validation ───────────────────────────────
      const xsdIssues = validateItemAgainstXsd(itemXml, schema.itemSchema, idx, sku);
      for (const issue of xsdIssues) {
        if (issue.level === "error") {
          allErrors.push(issue);
          xsdErrorCount++;
        } else {
          allWarnings.push(issue);
          xsdWarningCount++;
        }
      }

      // Track field presence for coverage stats
      for (const element of schema.itemSchema) {
        if (!element.children) {
          const value = extractChildValue(itemXml, element.name);
          if (value !== null) {
            fieldPresence[element.name] = (fieldPresence[element.name] || 0) + 1;
          }
        }
      }

      // Discover extra fields (first 10 items only)
      if (idx < 10) {
        const allChildTags = itemXml.match(/<([a-zA-Z][\w-]*)\b[^>]*>/g) || [];
        for (const tag of allChildTags) {
          const tagName = tag.replace(/<([a-zA-Z][\w-]*)\b.*/, "$1");
          if (!schema.itemSchema.find((f) => f.name === tagName)) {
            fieldPresence[`_extra:${tagName}`] = (fieldPresence[`_extra:${tagName}`] || 0) + 1;
          }
        }
      }
    }

    // ── Step 3b: Semantic attribute validation (article only) ─────
    // Check that key business attributes (Type schoen, Kleur) are present
    // in the attribuut-nm-* / attribuut-waarde-* pairs
    if (schema.fileType === "article" && itemCount > 0) {
      const REQUIRED_ATTRIBUTES = ["Type", "Kleur"];
      let missingTypeCount = 0;
      let missingKleurCount = 0;
      const missingTypeSamples: string[] = [];
      const missingKleurSamples: string[] = [];

      for (const idx of sampleIndices) {
        const itemXml = items[idx];
        const sku = extractChildValue(itemXml, "artikelnummer") || `item-${idx}`;

        // Extract all attribuut-nm-* values for this item
        const foundAttrNames: string[] = [];
        for (let i = 1; i <= 20; i++) {
          const attrName = extractChildValue(itemXml, `attribuut-nm-${i}`);
          if (attrName && attrName.trim()) {
            foundAttrNames.push(attrName.trim());
          }
        }

        // Check for "Type" (case-insensitive, also matches "Type schoen", "Type koffer", etc.)
        const hasType = foundAttrNames.some(n => n.toLowerCase().startsWith("type"));
        if (!hasType) {
          missingTypeCount++;
          if (missingTypeSamples.length < 5) missingTypeSamples.push(sku);
        }

        // Check for "Kleur" attribute (distinct from the <kleur> element — this is the webshop attribute)
        const hasKleur = foundAttrNames.some(n => n.toLowerCase() === "kleur");
        if (!hasKleur) {
          missingKleurCount++;
          if (missingKleurSamples.length < 5) missingKleurSamples.push(sku);
        }
      }

      if (missingTypeCount > 0) {
        allWarnings.push({
          level: "warning",
          field: "attribuut:Type",
          message: `${missingTypeCount}/${sampleIndices.length} artikelen missen attribuut 'Type' (schoen/koffer/etc.) — eerste: ${missingTypeSamples.join(", ")}`,
          xsdRule: "business-rule:required-attribute",
        });
      }

      if (missingKleurCount > 0) {
        allWarnings.push({
          level: "warning",
          field: "attribuut:Kleur",
          message: `${missingKleurCount}/${sampleIndices.length} artikelen missen attribuut 'Kleur' — eerste: ${missingKleurSamples.join(", ")}`,
          xsdRule: "business-rule:required-attribute",
        });
      }

      // Track in field presence stats
      fieldPresence["_semantic:Type"] = sampleIndices.length - missingTypeCount;
      fieldPresence["_semantic:Kleur"] = sampleIndices.length - missingKleurCount;
    }

    // Duplicate warnings
    if (duplicateSkuMaatPairs.length > 0) {
      allWarnings.push({
        level: "warning",
        field: "artikelnummer+maat-id",
        message: `${duplicateSkuMaatPairs.length} dubbele SKU+maat combinaties gevonden (eerste: ${duplicateSkuMaatPairs.slice(0, 5).join(", ")})`,
        xsdRule: "xs:unique",
      });
    }

    // ── Step 4: Compile stats ─────────────────────────────────────
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
      xsd_errors: xsdErrorCount,
      xsd_warnings: xsdWarningCount,
      validation_mode: strict ? "strict" : "permissive",
      field_coverage: Object.fromEntries(
        Object.entries(fieldPresence)
          .filter(([k]) => !k.startsWith("_extra:") && !k.startsWith("_semantic:"))
          .map(([k, v]) => [k, `${v}/${sampleIndices.length}`])
      ),
      semantic_attribute_coverage: Object.fromEntries(
        Object.entries(fieldPresence)
          .filter(([k]) => k.startsWith("_semantic:"))
          .map(([k, v]) => [k.replace("_semantic:", ""), `${v}/${sampleIndices.length}`])
      ),
      extra_fields: Object.entries(fieldPresence)
        .filter(([k]) => k.startsWith("_extra:"))
        .map(([k]) => k.replace("_extra:", "")),
      total_errors: allErrors.length,
      total_warnings: allWarnings.length,
    };

    console.log(
      `XSD Validation: ${isValid ? "VALID" : "INVALID"} | ${allErrors.length} errors (${xsdErrorCount} XSD), ${allWarnings.length} warnings (${xsdWarningCount} XSD) | ${itemCount} items, ${uniqueSkus.size} unique SKUs`
    );

    // ── Step 5: Log to DB ─────────────────────────────────────────
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

    // In strict mode, return 422 for invalid files (used as gate before processing)
    const httpStatus = strict && !isValid ? 422 : 200;

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
        status: httpStatus,
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
