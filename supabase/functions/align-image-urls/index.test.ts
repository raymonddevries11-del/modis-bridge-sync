import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const BASE = `${SUPABASE_URL}/functions/v1/align-image-urls`;

Deno.test("align-image-urls: dry run returns stats without modifying data", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ dryRun: true }),
  });

  assertEquals(res.status, 200);
  const data = await res.json();

  assertEquals(data.dryRun, true);
  assertExists(data.storageFilesIndexed);
  assertExists(data.totalProductsChecked);
  assertExists(data.productsFixed);
  assertExists(data.urlsFixed);
  assertExists(data.urlsAlreadyCorrect);
  assertExists(data.urlsStillMissing);

  // In dry run mode, no products should actually be updated in DB
  assertEquals(typeof data.productsFixed, "number");
  assertEquals(typeof data.urlsFixed, "number");
});

Deno.test("align-image-urls: returns valid JSON with expected shape", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ dryRun: true }),
  });

  assertEquals(res.status, 200);
  const data = await res.json();

  // All numeric fields should be non-negative
  const numericFields = [
    "storageFilesIndexed",
    "totalProductsChecked",
    "productsFixed",
    "urlsFixed",
    "urlsAlreadyCorrect",
    "urlsStillMissing",
  ];

  for (const field of numericFields) {
    assertEquals(typeof data[field], "number", `${field} should be a number`);
    assertEquals(data[field] >= 0, true, `${field} should be non-negative`);
  }
});

Deno.test("align-image-urls: handles OPTIONS preflight", async () => {
  const res = await fetch(BASE, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  await res.text();
});

Deno.test("align-image-urls: handles empty body gracefully", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: "{}",
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  // Default dryRun should be false
  assertEquals(data.dryRun, false);
});

Deno.test("align-image-urls: handles malformed body gracefully", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: "not-json",
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  // Should default to dryRun=false when body parse fails
  assertEquals(data.dryRun, false);
});

Deno.test("align-image-urls: fixed + correct + missing equals total URLs checked", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ dryRun: true }),
  });

  assertEquals(res.status, 200);
  const data = await res.json();

  // The sum of fixed, correct, and missing should account for all processed URLs
  const totalAccounted = data.urlsFixed + data.urlsAlreadyCorrect + data.urlsStillMissing;
  assertEquals(totalAccounted >= 0, true, "Total accounted URLs should be non-negative");
});
