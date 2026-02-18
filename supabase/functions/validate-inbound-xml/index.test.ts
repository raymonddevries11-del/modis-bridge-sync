import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const TENANT_ID = "f0dd152c-a807-4e04-b0a0-769e9229046b";
const BASE = `${SUPABASE_URL}/functions/v1/validate-inbound-xml`;

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

// ── XML fixtures using actual Modis field names ──────────────

const VALID_STOCK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<voorraad>
  <vrd>
    <artikelnummer>TEST-SKU-001</artikelnummer>
    <mutatiecode>W</mutatiecode>
    <aantal>10</aantal>
    <maat-id>42</maat-id>
  </vrd>
  <vrd>
    <artikelnummer>TEST-SKU-002</artikelnummer>
    <mutatiecode>W</mutatiecode>
    <aantal>5</aantal>
    <maat-id>38</maat-id>
  </vrd>
</voorraad>`;

const VALID_ARTICLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<artikelen>
  <artikel>
    <artikelnummer>TEST-ART-001</artikelnummer>
    <webshop-titel>Test Schoen Zwart</webshop-titel>
    <verkoopprijs>49,99</verkoopprijs>
    <merk>TestMerk</merk>
  </artikel>
</artikelen>`;

const INVALID_XML_MISSING_SKU = `<?xml version="1.0" encoding="UTF-8"?>
<voorraad>
  <vrd>
    <maat-id>42</maat-id>
    <aantal>10</aantal>
  </vrd>
</voorraad>`;

const EMPTY_XML = "";

const MALFORMED_XML = `<?xml version="1.0"?>
<voorraad>
  <vrd>
    <artikelnummer>BROKEN
  </vrd>
</voorraad>`;

// ── Tests ────────────────────────────────────────────────────

Deno.test("validate-inbound-xml: rejects missing tenantId", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ xmlContent: VALID_STOCK_XML, fileName: "test.xml" }),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.error?.includes("tenantId"), "Should mention missing tenantId");
});

Deno.test("validate-inbound-xml: rejects empty XML content", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ xmlContent: EMPTY_XML, fileName: "empty.xml", tenantId: TENANT_ID }),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.error?.includes("No XML"), "Should reject empty XML");
});

Deno.test("validate-inbound-xml: validates stock XML successfully", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      xmlContent: VALID_STOCK_XML,
      fileName: "voorraad-update.xml",
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assert(body.valid === true, `Expected valid, got errors: ${JSON.stringify(body.errors)}`);
  assert(body.fileType?.includes("stock"), `Expected stock type, got ${body.fileType}`);
  assert(body.itemCount >= 2, "Should find at least 2 vrd items");
  console.log(`✅ Stock XML validated: ${body.itemCount} items, confidence=${body.confidence}`);
});

Deno.test("validate-inbound-xml: validates article XML successfully", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      xmlContent: VALID_ARTICLE_XML,
      fileName: "artikelen-export.xml",
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assert(body.valid === true, `Expected valid, got errors: ${JSON.stringify(body.errors)}`);
  assertEquals(body.fileType, "article");
  assert(body.itemCount >= 1, "Should find at least 1 artikel");
  console.log(`✅ Article XML validated: ${body.itemCount} items`);
});

Deno.test("validate-inbound-xml: detects missing required fields", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      xmlContent: INVALID_XML_MISSING_SKU,
      fileName: "voorraad-missing.xml",
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  const allIssues = [...(body.errors || []), ...(body.warnings || [])];
  console.log(`ℹ️ Missing SKU result: valid=${body.valid}, errors=${body.errors?.length}, warnings=${body.warnings?.length}`);
  assert(allIssues.length > 0 || body.valid === false, "Should flag missing artikelnummer");
});

Deno.test("validate-inbound-xml: handles malformed XML gracefully", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      xmlContent: MALFORMED_XML,
      fileName: "broken.xml",
      tenantId: TENANT_ID,
    }),
  });
  assert([200, 500].includes(res.status), `Unexpected status ${res.status}`);
  const body = await res.json();
  if (res.status === 200) {
    console.log(`ℹ️ Malformed XML: valid=${body.valid}, errors=${body.errors?.length}`);
  } else {
    assert(body.error, "500 response should include error message");
    console.log(`ℹ️ Malformed XML returned 500: ${body.error}`);
  }
});

Deno.test("validate-inbound-xml: auto-detects file type from content", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      xmlContent: VALID_ARTICLE_XML,
      fileName: "unknown-file.xml",
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.fileType, "article", "Should detect article type from <artikel> tags");
  console.log(`✅ Auto-detected file type: ${body.fileType} (confidence: ${body.confidence})`);
});

Deno.test("validate-inbound-xml: duplicate SKU+maat detection", async () => {
  const xmlWithDupes = `<?xml version="1.0" encoding="UTF-8"?>
<voorraad>
  <vrd>
    <artikelnummer>DUPE-001</artikelnummer>
    <maat-id>42</maat-id>
    <mutatiecode>W</mutatiecode>
    <aantal>10</aantal>
  </vrd>
  <vrd>
    <artikelnummer>DUPE-001</artikelnummer>
    <maat-id>42</maat-id>
    <mutatiecode>W</mutatiecode>
    <aantal>3</aantal>
  </vrd>
</voorraad>`;

  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      xmlContent: xmlWithDupes,
      fileName: "voorraad-dupes.xml",
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  console.log(`ℹ️ Duplicate detection: warnings=${body.warnings?.length}, dupes=${body.stats?.duplicate_sku_maat_pairs}`);
  assert(body.stats?.duplicate_sku_maat_pairs >= 1 || body.warnings?.length > 0, "Should detect duplicate SKU+maat pairs");
});

Deno.test("validate-inbound-xml: response contains stats summary", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      xmlContent: VALID_STOCK_XML,
      fileName: `test-stats-${Date.now()}.xml`,
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assert(body.stats, "Response should contain stats");
  assert(typeof body.stats.item_count === "number", "stats.item_count should be a number");
  assert(typeof body.stats.unique_skus === "number", "stats.unique_skus should be a number");
  assert(body.stats.detected_type, "stats.detected_type should be set");
  console.log(`✅ Stats: ${JSON.stringify(body.stats)}`);
});
