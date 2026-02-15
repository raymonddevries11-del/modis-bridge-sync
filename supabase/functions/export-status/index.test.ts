import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Use hardcoded URL since env vars aren't available in test runner
const PROJECT_REF = "dnllaaspkqqfuuxkvoma";
const BASE = `https://${PROJECT_REF}.supabase.co/functions/v1/export-status`;
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo";

const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
};

Deno.test("export-status: returns 200 with summary and files", async () => {
  const res = await fetch(BASE, { headers });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertExists(body.summary);
  assertExists(body.files);
  assertExists(body.fetched_at);

  for (const key of ["pending", "uploaded", "acked", "timeout", "quarantined", "total"]) {
    assertEquals(typeof body.summary[key], "number", `summary.${key} should be a number`);
  }
});

Deno.test("export-status: filters by status param", async () => {
  const res = await fetch(`${BASE}?status=acked`, { headers });
  assertEquals(res.status, 200);

  const body = await res.json();
  for (const file of body.files) {
    assertEquals(file.ack_status, "acked");
  }
});

Deno.test("export-status: respects limit param", async () => {
  const res = await fetch(`${BASE}?limit=2`, { headers });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.files.length <= 2, true);
});

Deno.test("export-status: filters by tenant_id", async () => {
  const fakeTenant = "00000000-0000-0000-0000-000000000000";
  const res = await fetch(`${BASE}?tenant_id=${fakeTenant}`, { headers });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.files.length, 0);
  assertEquals(body.summary.total, 0);
});

Deno.test("export-status: filters by since param", async () => {
  const res = await fetch(`${BASE}?since=2099-01-01T00:00:00Z`, { headers });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.files.length, 0);
  assertEquals(body.summary.total, 0);
});

Deno.test("export-status: files contain expected fields", async () => {
  const res = await fetch(`${BASE}?limit=1`, { headers });
  assertEquals(res.status, 200);

  const body = await res.json();
  if (body.files.length > 0) {
    const file = body.files[0];
    for (const field of ["id", "filename", "order_number", "ack_status", "retry_count", "max_retries", "created_at", "tenant_id"]) {
      assertExists(file[field], `File should have field '${field}'`);
    }
  }
});

Deno.test("export-status: summary counts are consistent", async () => {
  const res = await fetch(BASE, { headers });
  assertEquals(res.status, 200);

  const body = await res.json();
  const sum = body.summary.pending + body.summary.uploaded + body.summary.acked + body.summary.timeout + body.summary.quarantined;
  assertEquals(sum, body.summary.total, "Sum of statuses should equal total");
});
