import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const TENANT_ID = "f0dd152c-a807-4e04-b0a0-769e9229046b";
const BASE = `${SUPABASE_URL}/functions/v1/process-articles`;

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

// ── Sample article XML ───────────────────────────────────────

const SINGLE_ARTICLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<artikelen>
  <artikel>
    <artnr>E2E-ART-001</artnr>
    <omschrijving>E2E Test Sneaker</omschrijving>
    <merk><merknaam>E2E Brand</merknaam></merk>
    <leverancier><leveranciernaam>E2E Supplier</leveranciernaam></leverancier>
    <verkoopprijs>89,95</verkoopprijs>
    <adviesprijs>99,95</adviesprijs>
    <inkoopprijs>45,00</inkoopprijs>
    <btw>21</btw>
    <artikelgroep>
      <artikelgroepnr>100</artikelgroepnr>
      <artikelgroepomschrijving>Schoenen</artikelgroepomschrijving>
    </artikelgroep>
    <kleur>
      <kleurnr>001</kleurnr>
      <kleuromschrijving>Zwart</kleuromschrijving>
    </kleur>
    <foto>
      <foto1>E2E-ART-001_1.jpg</foto1>
    </foto>
    <maten>
      <maat>
        <maatid>40</maatid>
        <maatalfa>40</maatalfa>
        <ean>8700000000001</ean>
        <voorraad>5</voorraad>
      </maat>
      <maat>
        <maatid>42</maatid>
        <maatalfa>42</maatalfa>
        <ean>8700000000002</ean>
        <voorraad>3</voorraad>
      </maat>
    </maten>
  </artikel>
</artikelen>`;

const MULTI_ARTICLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<artikelen>
  <artikel>
    <artnr>E2E-MULTI-001</artnr>
    <omschrijving>E2E Multi Product A</omschrijving>
    <merk><merknaam>E2E Brand</merknaam></merk>
    <verkoopprijs>39,95</verkoopprijs>
    <maten>
      <maat>
        <maatid>S</maatid>
        <maatalfa>S</maatalfa>
        <voorraad>10</voorraad>
      </maat>
    </maten>
  </artikel>
  <artikel>
    <artnr>E2E-MULTI-002</artnr>
    <omschrijving>E2E Multi Product B</omschrijving>
    <merk><merknaam>E2E Brand</merknaam></merk>
    <verkoopprijs>49,95</verkoopprijs>
    <maten>
      <maat>
        <maatid>M</maatid>
        <maatalfa>M</maatalfa>
        <voorraad>7</voorraad>
      </maat>
    </maten>
  </artikel>
</artikelen>`;

// ── Tests ────────────────────────────────────────────────────

Deno.test("process-articles: rejects missing fileName", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ xmlContent: SINGLE_ARTICLE_XML, tenantId: TENANT_ID }),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.error, "Should return error for missing fileName");
});

Deno.test("process-articles: rejects missing xmlContent", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileName: "test.xml", tenantId: TENANT_ID }),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.error, "Should return error for missing xmlContent");
});

Deno.test("process-articles: rejects XML with no articles", async () => {
  const emptyXml = `<?xml version="1.0"?><artikelen></artikelen>`;
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fileName: "empty-articles.xml",
      xmlContent: emptyXml,
      tenantId: TENANT_ID,
    }),
  });
  // Should return error (either 400 or 500) for empty articles
  const body = await res.json();
  // The function throws "No articles found" which returns 500
  assert([400, 500].includes(res.status) || body.error, "Should reject empty article XML");
  console.log(`✅ Empty articles correctly rejected: ${res.status}`);
});

Deno.test("process-articles: processes single article successfully", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fileName: "e2e-single-article.xml",
      xmlContent: SINGLE_ARTICLE_XML,
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assert(body.message || body.started, "Should return success indication");
  console.log(`✅ Single article processed: ${JSON.stringify(body)}`);
});

Deno.test("process-articles: processes multiple articles", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fileName: "e2e-multi-articles.xml",
      xmlContent: MULTI_ARTICLE_XML,
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assert(body.message || body.started, "Should return success indication");
  // Check that article count is reported
  if (body.articleCount) {
    assertEquals(body.articleCount, 2, "Should report 2 articles found");
  }
  console.log(`✅ Multi article processed: ${JSON.stringify(body)}`);
});

Deno.test("process-articles: handles CORS preflight", async () => {
  const res = await fetch(BASE, { method: "OPTIONS", headers });
  assertEquals(res.status, 200);
  await res.text(); // consume body
  console.log("✅ CORS preflight OK");
});
