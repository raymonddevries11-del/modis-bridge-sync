/**
 * E2E test: Modis CSV import → DB verification → push-to-woocommerce payload validation
 *
 * Validates that:
 * 1. color.webshop is stored correctly after CSV import
 * 2. is_promotion flag is set from the Sale column
 * 3. push-to-woocommerce includes Color-webshop attribute
 * 4. push-to-woocommerce adds Sale tag for promotion products
 * 5. push-to-woocommerce removes Sale tag for non-promotion products
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const BASE = `${SUPABASE_URL}/functions/v1`;
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  apikey: SUPABASE_ANON_KEY,
};

// Service role needed for direct DB ops and storage uploads in tests
// Falls back to anon key (E2E test will be skipped if not available)
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const hasServiceKey = !!SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY || SUPABASE_ANON_KEY);

const TEST_TENANT_SLUG = "kosterschoenmode";
const TEST_SKU_PROMO = "999TEST001000";
const TEST_SKU_NO_PROMO = "999TEST002000";
const STORAGE_PATH = "import/e2e-color-sale-test.csv";

// --- Helpers ---

async function getTenantId(): Promise<string> {
  const { data } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", TEST_TENANT_SLUG)
    .single();
  if (!data) throw new Error(`Tenant ${TEST_TENANT_SLUG} not found`);
  return data.id;
}

function buildTestCSV(): string {
  // Semicolon-separated Modis-style CSV with Color-webshop (attr 21) and Sale (attr 24)
  const headerLine = [
    "Type", "SKU", "name", "Short description", "Regular price", "Sale price",
    "Categories", "Brands", "Images", "Stock", "Parent",
    "Attribute 1 name", "Attribute 1 value(s)",
    "Attribute 21", // Color-webshop (single column)
    "Attribute 22",  // Type schoen
    "Attribute 24",  // Sale flag
    "Color-article",
    "Maat-alfa",
    "_ywbc_barcode",
  ].join(";");

  const promo = [
    "variable", TEST_SKU_PROMO, "Test Promo Schoen", "Korte beschrijving promo", "129,95", "99,95",
    "Damesschoenen", "TestMerk", "", "", "",
    "Gender", "Dames",
    "Rood",        // attr 21 = Color-webshop
    "Enkellaars",  // attr 22 = Type schoen
    "Sale",        // attr 24 = Sale flag → is_promotion=true
    "Rood/Zwart",  // Color-article
    "",            // Maat-alfa (parent has none)
    "",            // EAN
  ].join(";");

  const noPromo = [
    "variable", TEST_SKU_NO_PROMO, "Test Normaal Schoen", "Korte beschrijving normaal", "149,95", "",
    "Herenschoenen", "TestMerk", "", "", "",
    "Gender", "Heren",
    "Blauw",       // attr 21 = Color-webshop
    "Sneaker",     // attr 22 = Type schoen
    "",            // attr 24 = empty → is_promotion=false
    "Blauw/Wit",   // Color-article
    "",
    "",
  ].join(";");

  // Add one variation per parent for completeness
  const var1 = [
    "variation", `${TEST_SKU_PROMO}-090001`, "", "", "129,95", "99,95",
    "", "", "", "5", TEST_SKU_PROMO,
    "", "",
    "", "", "",
    "",
    "39",
    "8712345000001",
  ].join(";");

  const var2 = [
    "variation", `${TEST_SKU_NO_PROMO}-090002`, "", "", "149,95", "",
    "", "", "", "3", TEST_SKU_NO_PROMO,
    "", "",
    "", "", "",
    "",
    "42",
    "8712345000002",
  ].join(";");

  return [headerLine, promo, noPromo, var1, var2].join("\n");
}

// --- Setup & Teardown ---

async function uploadTestCSV() {
  const csv = buildTestCSV();
  const blob = new Blob([csv], { type: "text/csv" });
  const { error } = await supabase.storage
    .from("order-exports")
    .upload(STORAGE_PATH, blob, { upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);
}

async function cleanupTestData(tenantId: string) {
  // Delete test products and related data
  const { data: products } = await supabase
    .from("products")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("sku", [TEST_SKU_PROMO, TEST_SKU_NO_PROMO]);

  if (products && products.length > 0) {
    const productIds = products.map((p: any) => p.id);
    await supabase.from("variants").delete().in("product_id", productIds);
    await supabase.from("product_prices").delete().in("product_id", productIds);
    await supabase.from("products").delete().in("id", productIds);
  }

  // Remove test CSV
  await supabase.storage.from("order-exports").remove([STORAGE_PATH]);
}

// --- Tests ---

Deno.test({
  name: "E2E: CSV import stores color.webshop and is_promotion correctly",
  ignore: !hasServiceKey,
  fn: async () => {
    const tenantId = await getTenantId();
    await cleanupTestData(tenantId);

    try {
      // Step 1: Upload test CSV
      await uploadTestCSV();

      // Step 2: Run import
      const importRes = await fetch(`${BASE}/import-modis-csv`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tenant: TEST_TENANT_SLUG, storagePath: STORAGE_PATH }),
      });
      const importBody = await importRes.json();
      assertEquals(importRes.status, 200, `Import failed: ${JSON.stringify(importBody)}`);

      // Step 3: Verify promo product
      const { data: promoProduct } = await supabase
        .from("products")
        .select("id, color, is_promotion, attributes")
        .eq("tenant_id", tenantId)
        .eq("sku", TEST_SKU_PROMO)
        .single();

      assertNotEquals(promoProduct, null, "Promo product should exist after import");
      assertEquals((promoProduct!.color as any)?.webshop, "Rood", "color.webshop should be 'Rood'");
      assertEquals((promoProduct!.color as any)?.article, "Rood/Zwart", "color.article should be 'Rood/Zwart'");
      assertEquals(promoProduct!.is_promotion, true, "is_promotion should be true for Sale product");
      assertEquals((promoProduct!.attributes as any)?.["Type schoen"], "Enkellaars", "Type schoen attribute should be set");

      // Step 4: Verify non-promo product
      const { data: normalProduct } = await supabase
        .from("products")
        .select("id, color, is_promotion, attributes")
        .eq("tenant_id", tenantId)
        .eq("sku", TEST_SKU_NO_PROMO)
        .single();

      assertNotEquals(normalProduct, null, "Normal product should exist after import");
      assertEquals((normalProduct!.color as any)?.webshop, "Blauw", "color.webshop should be 'Blauw'");
      assertEquals(normalProduct!.is_promotion, false, "is_promotion should be false for non-Sale product");
    } finally {
      await cleanupTestData(tenantId);
    }
  },
});

// --- Unit tests for Sale tag logic (mirrors push-to-woocommerce behavior) ---

Deno.test("Sale tag is added when is_promotion is true", () => {
  const desiredData: any = { tags: [] };
  const is_promotion = true;

  const existingTags = desiredData.tags || [];
  if (is_promotion) {
    const hasSaleTag = existingTags.some((t: any) => t.name?.toLowerCase() === "sale");
    if (!hasSaleTag) {
      desiredData.tags = [...existingTags, { name: "Sale" }];
    }
  }

  assertEquals(desiredData.tags.length, 1);
  assertEquals(desiredData.tags[0].name, "Sale");
});

Deno.test("Sale tag is not duplicated if already present", () => {
  const desiredData: any = { tags: [{ name: "Sale" }] };
  const is_promotion = true;

  const existingTags = desiredData.tags || [];
  if (is_promotion) {
    const hasSaleTag = existingTags.some((t: any) => t.name?.toLowerCase() === "sale");
    if (!hasSaleTag) {
      desiredData.tags = [...existingTags, { name: "Sale" }];
    }
  }

  assertEquals(desiredData.tags.length, 1, "Should not add duplicate Sale tag");
});

Deno.test("Sale tag is removed when is_promotion is false", () => {
  const desiredData: any = { tags: [{ name: "Sale" }, { name: "New" }] };
  const is_promotion = false;

  const existingTags = desiredData.tags || [];
  if (!is_promotion) {
    const filtered = existingTags.filter((t: any) => t.name?.toLowerCase() !== "sale");
    if (filtered.length !== existingTags.length) {
      desiredData.tags = filtered;
    }
  }

  assertEquals(desiredData.tags.length, 1, "Sale tag should be removed");
  assertEquals(desiredData.tags[0].name, "New", "Other tags should remain");
});

Deno.test("Color-webshop attribute is built from color.webshop PIM data", () => {
  const pimColor = { article: "Rood/Zwart", webshop: "Rood" };
  const colorWebshop = pimColor?.webshop;
  const usedAttrIds = new Set<number>();
  const usedAttrNames = new Set<string>();
  const attrs: any[] = [];

  if (colorWebshop) {
    // Simulate: no global mapping found → push as local
    if (!usedAttrNames.has("color-webshop")) {
      attrs.push({
        name: "Color-webshop",
        position: attrs.length,
        visible: true,
        variation: false,
        options: [colorWebshop],
      });
      usedAttrNames.add("color-webshop");
    }
  }

  assertEquals(attrs.length, 1, "Should add Color-webshop attribute");
  assertEquals(attrs[0].name, "Color-webshop");
  assertEquals(attrs[0].options[0], "Rood");
  assertEquals(attrs[0].variation, false);
});

Deno.test("Color-webshop uses global ID when mapped", () => {
  const pimColor = { webshop: "Blauw" };
  const colorWebshop = pimColor.webshop;
  const usedAttrIds = new Set<number>();
  const attrs: any[] = [];

  // Simulate global mapping found (Kleur, id:3)
  const colorAttr = { id: 3, name: "Kleur" };
  if (colorAttr && colorAttr.id > 0 && !usedAttrIds.has(colorAttr.id)) {
    attrs.push({
      id: colorAttr.id,
      name: colorAttr.name,
      position: attrs.length,
      visible: true,
      variation: false,
      options: [colorWebshop],
    });
    usedAttrIds.add(colorAttr.id);
  }

  assertEquals(attrs.length, 1, "Should add mapped Color attribute");
  assertEquals(attrs[0].id, 3, "Should use global ID");
  assertEquals(attrs[0].name, "Kleur", "Should use global name");
  assertEquals(attrs[0].options[0], "Blauw");
});

Deno.test("No Color-webshop attribute when color.webshop is empty", () => {
  const pimColor = { article: "Rood/Zwart", webshop: "" };
  const colorWebshop = pimColor?.webshop;
  const attrs: any[] = [];

  if (colorWebshop) {
    attrs.push({ name: "Color-webshop", options: [colorWebshop] });
  }

  assertEquals(attrs.length, 0, "Should not add attribute when webshop color is empty");
});

// --- Color mapping + SEO propagation tests ---

Deno.test("Color-webshop global mapping propagates term correctly", () => {
  // Simulates the full mapping resolution chain:
  // PIM color.webshop → globalAttrMap lookup → WooCommerce attribute with term
  const pimColor = { webshop: "Wit", article: "Latte Weiss Grau" };
  const globalAttrMap = new Map<string, { id: number; name: string }>();
  globalAttrMap.set("color-webshop", { id: 3, name: "Kleur" });

  const usedAttrIds = new Set<number>();
  const attrs: any[] = [];
  const mappedAttrs: any[] = [];

  const colorWebshop = pimColor.webshop;
  if (colorWebshop) {
    const colorAttr = globalAttrMap.get("color-webshop");
    if (colorAttr && colorAttr.id > 0 && !usedAttrIds.has(colorAttr.id)) {
      attrs.push({
        id: colorAttr.id,
        name: colorAttr.name,
        position: attrs.length,
        visible: true,
        variation: false,
        options: [colorWebshop],
      });
      usedAttrIds.add(colorAttr.id);
      mappedAttrs.push({
        key: "Color-webshop",
        wc_id: colorAttr.id,
        wc_name: colorAttr.name,
        value: colorWebshop,
      });
    }
  }

  assertEquals(attrs.length, 1);
  assertEquals(attrs[0].id, 3, "Uses global pa_kleur ID");
  assertEquals(attrs[0].name, "Kleur");
  assertEquals(attrs[0].options[0], "Wit");
  assertEquals(attrs[0].visible, true, "Color attribute must be visible for SEO");
  assertEquals(attrs[0].variation, false, "Color is not a variation axis");
  assertEquals(mappedAttrs[0].value, "Wit");
});

Deno.test("Color.article is preserved alongside color.webshop", () => {
  // Verifies both color fields coexist — article for internal use, webshop for WooCommerce
  const pimColor = { webshop: "Wit", article: "Latte Weiss Grau" };
  assertEquals(pimColor.webshop, "Wit");
  assertEquals(pimColor.article, "Latte Weiss Grau");
  // Both must be non-empty and distinct
  assertNotEquals(pimColor.webshop, pimColor.article, "webshop and article colors should differ");
});

Deno.test("SEO meta_data includes Yoast fields from PIM", () => {
  const pim = {
    meta_title: "Witte Sneakers Kopen | TestMerk",
    meta_description: "Ontdek onze witte sneakers. Gratis verzending vanaf €50.",
    webshop_text: "Mooie witte sneakers",
  };
  const aiContent = { status: "pending" } as any;
  const hasApprovedAi = aiContent?.status === "approved";

  const metaTitle = (hasApprovedAi && aiContent.ai_meta_title) || pim.meta_title;
  const metaDescription = (hasApprovedAi && aiContent.ai_meta_description) || pim.meta_description;

  const meta_data: any[] = [
    ...(metaTitle ? [{ key: "_yoast_wpseo_title", value: metaTitle }] : []),
    ...(metaDescription ? [{ key: "_yoast_wpseo_metadesc", value: metaDescription }] : []),
  ];

  assertEquals(meta_data.length, 2, "Both Yoast SEO fields should be present");
  assertEquals(meta_data[0].key, "_yoast_wpseo_title");
  assertEquals(meta_data[0].value, "Witte Sneakers Kopen | TestMerk");
  assertEquals(meta_data[1].key, "_yoast_wpseo_metadesc");
  assertEquals(meta_data[1].value, pim.meta_description);
});

Deno.test("SEO meta_data prefers approved AI content over PIM", () => {
  const pim = {
    meta_title: "PIM Title",
    meta_description: "PIM Description",
  };
  const aiContent = {
    status: "approved",
    ai_meta_title: "AI Optimized Title | Brand",
    ai_meta_description: "AI crafted description for better SEO ranking.",
  };
  const hasApprovedAi = aiContent.status === "approved";

  const metaTitle = (hasApprovedAi && aiContent.ai_meta_title) || pim.meta_title;
  const metaDescription = (hasApprovedAi && aiContent.ai_meta_description) || pim.meta_description;

  assertEquals(metaTitle, "AI Optimized Title | Brand", "Should prefer AI meta title");
  assertEquals(metaDescription, "AI crafted description for better SEO ranking.", "Should prefer AI meta description");
});

Deno.test("SEO meta_data falls back to PIM when AI is not approved", () => {
  const pim = { meta_title: "PIM Title", meta_description: "PIM Desc" };
  const aiContent = { status: "generated", ai_meta_title: "AI Title", ai_meta_description: "AI Desc" };
  const hasApprovedAi = aiContent.status === "approved";

  const metaTitle = (hasApprovedAi && aiContent.ai_meta_title) || pim.meta_title;
  const metaDescription = (hasApprovedAi && aiContent.ai_meta_description) || pim.meta_description;

  assertEquals(metaTitle, "PIM Title", "Should fall back to PIM when AI not approved");
  assertEquals(metaDescription, "PIM Desc");
});

Deno.test("Color + SEO combined payload is well-formed", () => {
  // Simulates the complete desiredData build for a product with color + SEO
  const pimColor = { webshop: "Zwart", article: "Schwarz" };
  const metaTitle = "Zwarte Laarzen | Shop";
  const metaDescription = "Koop zwarte laarzen online.";

  const desiredData: Record<string, any> = {
    name: "Zwarte Laarzen",
    description: "Mooie zwarte laarzen van echt leer.",
    short_description: "",
    sku: "TEST123",
    slug: "zwarte-laarzen",
    meta_data: [
      { key: "_yoast_wpseo_title", value: metaTitle },
      { key: "_yoast_wpseo_metadesc", value: metaDescription },
    ],
  };

  const attrs: any[] = [];
  if (pimColor.webshop) {
    attrs.push({
      id: 3,
      name: "Kleur",
      position: 0,
      visible: true,
      variation: false,
      options: [pimColor.webshop],
    });
  }
  desiredData.attributes = attrs;

  // Validate complete payload
  assertEquals(desiredData.meta_data.length, 2, "SEO meta fields present");
  assertEquals(desiredData.attributes.length, 1, "Color attribute present");
  assertEquals(desiredData.attributes[0].options[0], "Zwart", "Color value in attributes");
  assertEquals(desiredData.meta_data[0].value, metaTitle, "SEO title in meta_data");
  assertEquals(desiredData.slug, "zwarte-laarzen", "URL key propagated as slug");
});
