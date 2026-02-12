const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Cache the taxonomy in memory
let cachedTaxonomy: { id: string; name: string }[] | null = null;

async function loadTaxonomy(): Promise<{ id: string; name: string }[]> {
  if (cachedTaxonomy) return cachedTaxonomy;

  const response = await fetch(
    'https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt'
  );
  const text = await response.text();

  const categories: { id: string; name: string }[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
    // Format: "ID - Category > Subcategory > ..."
    const dashIndex = trimmed.indexOf(' - ');
    if (dashIndex === -1) continue;
    const id = trimmed.substring(0, dashIndex).trim();
    const name = trimmed.substring(dashIndex + 3).trim();
    if (id && name) {
      categories.push({ id, name });
    }
  }

  cachedTaxonomy = categories;
  return categories;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let search = '';
    let limit = 50;

    if (req.method === 'POST') {
      const body = await req.json();
      search = (body.q || '').toLowerCase().trim();
      limit = parseInt(body.limit || '50', 10);
    } else {
      const url = new URL(req.url);
      search = (url.searchParams.get('q') || '').toLowerCase().trim();
      limit = parseInt(url.searchParams.get('limit') || '50', 10);
    }

    const taxonomy = await loadTaxonomy();

    let results: { id: string; name: string }[];

    if (!search) {
      // Return top-level categories only when no search
      results = taxonomy.filter(c => !c.name.includes(' > ')).slice(0, limit);
    } else {
      // Score-based search with parent path matching
      const terms = search.split(/\s+/);
      const scored = taxonomy
        .filter(c => terms.every(t => c.name.toLowerCase().includes(t)))
        .map(c => {
          const segments = c.name.split(' > ');
          const lastSegment = segments[segments.length - 1].toLowerCase();
          let score = 0;

          // Exact match on last segment
          if (lastSegment === search) score += 30;
          // Last segment contains search
          else if (lastSegment.includes(search)) score += 15;
          // Any segment contains search (parent path match)
          else if (segments.some(s => s.toLowerCase().includes(search))) score += 5;

          // Prefer shorter paths (more specific categories rank higher when equal)
          score += Math.max(0, 10 - segments.length * 2);

          return { ...c, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      results = scored;
    }

    return new Response(JSON.stringify({ categories: results, total: taxonomy.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error loading taxonomy:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to load taxonomy' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
