import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

const BASE_URL = `${SUPABASE_URL}/functions/v1/push-to-woocommerce`;

Deno.test("rejects request without tenantId", async () => {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  assertEquals(res.status, 500);
  assertEquals(body.error, "tenantId is required");
});

Deno.test("rejects request without productIds", async () => {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ tenantId: "00000000-0000-0000-0000-000000000000" }),
  });
  const body = await res.json();
  assertEquals(res.status, 500);
  assertEquals(body.error, "productIds array is required");
});

// --- Unit-style tests for attribute ID logic ---

Deno.test("variation attribute uses global ID when maatAttrId is set", () => {
  const maatAttrId = 42;
  const variant = { size_label: "43 = 9" };

  // Replicate the logic from the edge function
  const attrRef = maatAttrId ? { id: maatAttrId } : { name: "pa_maat" };
  const attributes = [{ ...attrRef, option: variant.size_label }];

  assertEquals(attributes.length, 1);
  assertEquals(attributes[0].id, 42);
  assertEquals(attributes[0].option, "43 = 9");
  // Must NOT have id: 0
  assertNotEquals(attributes[0].id, 0);
  // Must NOT have name when using global ID
  assertEquals("name" in attributes[0], false);
});

Deno.test("variation attribute falls back to pa_maat slug when no global ID", () => {
  const maatAttrId: number | null = null;
  const variant = { size_label: "40 = 6½" };

  const attrRef = maatAttrId ? { id: maatAttrId } : { name: "pa_maat" };
  const attributes = [{ ...attrRef, option: variant.size_label }];

  assertEquals(attributes.length, 1);
  assertEquals((attributes[0] as any).name, "pa_maat");
  assertEquals(attributes[0].option, "40 = 6½");
  // Must NOT have id: 0
  assertEquals("id" in attributes[0], false);
});

Deno.test("parent product maat attribute uses global ID", () => {
  const maatAttrId = 7;
  const sizeOptions = ["40 = 6½", "41 = 7½", "42 = 8"];

  const maatAttrDef: any = { position: 0, visible: true, variation: true, options: sizeOptions };
  if (maatAttrId) {
    maatAttrDef.id = maatAttrId;
  } else {
    maatAttrDef.name = "Maat";
  }

  assertEquals(maatAttrDef.id, 7);
  assertEquals(maatAttrDef.options, sizeOptions);
  assertEquals(maatAttrDef.variation, true);
  // Must NOT have name when using global ID (name is only needed for local attrs)
  assertEquals("name" in maatAttrDef, false);
});

Deno.test("parent product maat attribute falls back to name when no global ID", () => {
  const maatAttrId: number | null = null;
  const sizeOptions = ["40 = 6½", "42 = 8"];

  const maatAttrDef: any = { position: 0, visible: true, variation: true, options: sizeOptions };
  if (maatAttrId) {
    maatAttrDef.id = maatAttrId;
  } else {
    maatAttrDef.name = "Maat";
  }

  assertEquals(maatAttrDef.name, "Maat");
  assertEquals("id" in maatAttrDef, false);
});

Deno.test("no variation ever gets id: 0", () => {
  const testCases = [
    { maatAttrId: 1, label: "41 = 7½" },
    { maatAttrId: 99, label: "46 = 11" },
    { maatAttrId: null as number | null, label: "38 = 5" },
  ];

  for (const tc of testCases) {
    const attrRef = tc.maatAttrId ? { id: tc.maatAttrId } : { name: "pa_maat" };
    const attr = { ...attrRef, option: tc.label };

    if ("id" in attr) {
      assertNotEquals(attr.id, 0, `Variation for ${tc.label} must not have id: 0`);
    }
  }
});
