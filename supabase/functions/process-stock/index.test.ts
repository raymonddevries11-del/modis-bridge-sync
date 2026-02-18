import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const TENANT_ID = "f0dd152c-a807-4e04-b0a0-769e9229046b";

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

// ── Sample stock XML fixtures ────────────────────────────────

const INCREMENTAL_STOCK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<voorraad>
  <vrd>
    <artnr>E2E-STOCK-001</artnr>
    <maatid>42</maatid>
    <maatalfa>42</maatalfa>
    <mutatiecode>W</mutatiecode>
    <aantal>15</aantal>
    <verkoopprijs>59,95</verkoopprijs>
  </vrd>
  <vrd>
    <artnr>E2E-STOCK-001</artnr>
    <maatid>43</maatid>
    <maatalfa>43</maatalfa>
    <mutatiecode>W</mutatiecode>
    <aantal>8</aantal>
    <verkoopprijs>59,95</verkoopprijs>
  </vrd>
</voorraad>`;

const FULL_STOCK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<voorraad>
  <vrd>
    <artnr>E2E-FULL-001</artnr>
    <maatid>40</maatid>
    <maatalfa>40</maatalfa>
    <aantal>20</aantal>
  </vrd>
  <vrd>
    <artnr>E2E-FULL-001</artnr>
    <maatid>41</maatid>
    <maatalfa>41</maatalfa>
    <aantal>0</aantal>
  </vrd>
</voorraad>`;

const EMPTY_STOCK_XML = `<?xml version="1.0"?><voorraad></voorraad>`;

// ── Incremental stock tests ──────────────────────────────────

Deno.test("process-stock: processes incremental stock XML", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-stock`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fileName: "e2e-voorraad-incr.xml",
      xmlContent: INCREMENTAL_STOCK_XML,
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assert(body.message || body.started || body.stockItems, "Should return success");
  console.log(`✅ Incremental stock processed: ${JSON.stringify(body)}`);
});

Deno.test("process-stock: rejects empty stock XML", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-stock`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fileName: "empty-stock.xml",
      xmlContent: EMPTY_STOCK_XML,
      tenantId: TENANT_ID,
    }),
  });
  const body = await res.json();
  assert([400, 500].includes(res.status) || body.error, "Should reject empty stock XML");
  console.log(`✅ Empty stock correctly rejected: ${res.status}`);
});

Deno.test("process-stock: handles CORS preflight", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-stock`, {
    method: "OPTIONS",
    headers,
  });
  assertEquals(res.status, 200);
  await res.text();
  console.log("✅ CORS preflight OK");
});

// ── Full stock tests ─────────────────────────────────────────

Deno.test("process-stock-full: processes full stock correction XML", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-stock-full`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fileName: "e2e-totale-vrd.xml",
      xmlContent: FULL_STOCK_XML,
      tenantId: TENANT_ID,
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();

  assert(body.message || body.started || body.success, "Should return success");
  console.log(`✅ Full stock processed: ${JSON.stringify(body)}`);
});

Deno.test("process-stock-full: rejects empty XML", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-stock-full`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fileName: "empty-full.xml",
      xmlContent: EMPTY_STOCK_XML,
      tenantId: TENANT_ID,
    }),
  });
  const body = await res.json();
  assert([400, 500].includes(res.status) || body.error, "Should reject empty full stock XML");
  console.log(`✅ Empty full stock correctly rejected: ${res.status}`);
});

Deno.test("process-stock-full: handles CORS preflight", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-stock-full`, {
    method: "OPTIONS",
    headers,
  });
  assertEquals(res.status, 200);
  await res.text();
  console.log("✅ CORS preflight OK");
});
