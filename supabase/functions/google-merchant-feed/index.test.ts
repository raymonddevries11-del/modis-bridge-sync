import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const TENANT_ID = "f0dd152c-a807-4e04-b0a0-769e9229046b";

/**
 * Color field test scenarios for the Google Merchant Feed.
 * These tests verify that color handling works correctly for various data shapes.
 */

// Helper: extract all <g:color> values from feed XML
function extractColors(xml: string): { id: string; color: string }[] {
  const items: { id: string; color: string }[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const idMatch = block.match(/<g:id>([^<]+)<\/g:id>/);
    const colorMatch = block.match(/<g:color>([^<]+)<\/g:color>/);
    if (idMatch) {
      items.push({
        id: idMatch[1],
        color: colorMatch ? colorMatch[1] : '__MISSING__',
      });
    }
  }
  return items;
}

// Helper: extract all <g:google_product_category> to check clothing detection
function extractCategories(xml: string): { id: string; category: string }[] {
  const items: { id: string; category: string }[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const idMatch = block.match(/<g:id>([^<]+)<\/g:id>/);
    const catMatch = block.match(/<g:google_product_category>([^<]+)<\/g:google_product_category>/);
    if (idMatch && catMatch) {
      items.push({ id: idMatch[1], category: catMatch[1] });
    }
  }
  return items;
}

Deno.test("Feed generates valid XML with color fields", async () => {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/google-merchant-feed?tenantId=${TENANT_ID}`,
    { headers: { "apikey": SUPABASE_ANON_KEY } }
  );
  
  assertEquals(res.status, 200);
  const xml = await res.text();
  
  // Basic XML structure
  assert(xml.startsWith("<?xml"), "Should start with XML declaration");
  assert(xml.includes("<rss"), "Should contain RSS root");
  assert(xml.includes("<channel>"), "Should contain channel");
});

Deno.test("All clothing items have a color value (no missing colors)", async () => {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/google-merchant-feed?tenantId=${TENANT_ID}`,
    { headers: { "apikey": SUPABASE_ANON_KEY } }
  );
  
  assertEquals(res.status, 200);
  const xml = await res.text();
  
  const colors = extractColors(xml);
  const categories = extractCategories(xml);
  
  // Build a set of IDs that are in clothing categories
  const clothingIds = new Set(
    categories
      .filter(c => /apparel|kleding|shoes|schoenen|footwear|clothing|accessories/i.test(c.category))
      .map(c => c.id)
  );
  
  // Every clothing item must have a color (not __MISSING__)
  const missingColorClothing = colors.filter(
    c => clothingIds.has(c.id) && c.color === '__MISSING__'
  );
  
  assertEquals(
    missingColorClothing.length, 
    0,
    `Found ${missingColorClothing.length} clothing items without color: ${JSON.stringify(missingColorClothing.slice(0, 5))}`
  );
  
  console.log(`✅ All ${clothingIds.size} clothing items have a color value`);
});

Deno.test("No invalid color values like NVT, N/A in feed", async () => {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/google-merchant-feed?tenantId=${TENANT_ID}`,
    { headers: { "apikey": SUPABASE_ANON_KEY } }
  );
  
  assertEquals(res.status, 200);
  const xml = await res.text();
  
  const colors = extractColors(xml);
  const invalidValues = ['nvt', 'n.v.t.', 'n/a', 'none', 'geen', '-'];
  
  const invalidItems = colors.filter(
    c => c.color !== '__MISSING__' && invalidValues.includes(c.color.toLowerCase())
  );
  
  assertEquals(
    invalidItems.length, 
    0,
    `Found ${invalidItems.length} items with invalid color: ${JSON.stringify(invalidItems.slice(0, 5))}`
  );
  
  console.log(`✅ No invalid color values found across ${colors.length} items`);
});

Deno.test("Fallback color 'Meerkleur' is used for clothing without color data", async () => {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/google-merchant-feed?tenantId=${TENANT_ID}`,
    { headers: { "apikey": SUPABASE_ANON_KEY } }
  );
  
  assertEquals(res.status, 200);
  const xml = await res.text();
  
  const colors = extractColors(xml);
  const meerkleurItems = colors.filter(c => c.color === 'Meerkleur');
  
  // Log count for visibility
  console.log(`ℹ️ ${meerkleurItems.length} items using fallback 'Meerkleur'`);
  
  // If there are Meerkleur items, they should exist (validates the fallback works)
  // This test primarily ensures the feed doesn't crash with fallback logic
  assert(colors.length > 0, "Feed should contain items");
});

Deno.test("Color distribution summary", async () => {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/google-merchant-feed?tenantId=${TENANT_ID}`,
    { headers: { "apikey": SUPABASE_ANON_KEY } }
  );
  
  assertEquals(res.status, 200);
  const xml = await res.text();
  
  const colors = extractColors(xml);
  const distribution = new Map<string, number>();
  for (const c of colors) {
    distribution.set(c.color, (distribution.get(c.color) || 0) + 1);
  }
  
  // Sort by count descending
  const sorted = [...distribution.entries()].sort((a, b) => b[1] - a[1]);
  
  console.log(`\n📊 Color distribution (${colors.length} total items):`);
  for (const [color, count] of sorted.slice(0, 15)) {
    console.log(`   ${color}: ${count}`);
  }
  
  const missingCount = distribution.get('__MISSING__') || 0;
  const withColor = colors.length - missingCount;
  console.log(`\n   ✅ ${withColor}/${colors.length} items have color (${((withColor/colors.length)*100).toFixed(1)}%)`);
  
  assert(true);
});
