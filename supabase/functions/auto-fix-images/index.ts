import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ChunkResult {
  success: boolean;
  fixedProducts: number;
  convertedUrls: number;
  notFoundInBucket: number;
  complete: boolean;
  nextOffset: number | null;
  error?: string;
}

async function runFixChunk(
  supabaseUrl: string,
  anonKey: string,
  tenant: string,
  offset: number,
  chunkSize: number,
  attempt: number,
  maxAttempts: number,
): Promise<ChunkResult> {
  const url = `${supabaseUrl}/functions/v1/fix-image-urls`;

  for (let a = attempt; a <= maxAttempts; a++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ tenant, offset, chunkSize, dryRun: false }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`Chunk offset=${offset} attempt ${a}/${maxAttempts} failed: ${res.status} ${text}`);
        if (a < maxAttempts) {
          await new Promise(r => setTimeout(r, 2000 * a));
          continue;
        }
        return { success: false, fixedProducts: 0, convertedUrls: 0, notFoundInBucket: 0, complete: false, nextOffset: offset, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }

      const data = await res.json();
      return {
        success: true,
        fixedProducts: data.fixedProducts || 0,
        convertedUrls: data.convertedUrls || 0,
        notFoundInBucket: data.notFoundInBucket || 0,
        complete: data.complete ?? !data.hasMore,
        nextOffset: data.nextOffset ?? null,
      };
    } catch (err) {
      console.error(`Chunk offset=${offset} attempt ${a}/${maxAttempts} error:`, err);
      if (a < maxAttempts) {
        await new Promise(r => setTimeout(r, 2000 * a));
        continue;
      }
      return { success: false, fixedProducts: 0, convertedUrls: 0, notFoundInBucket: 0, complete: false, nextOffset: offset, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  return { success: false, fixedProducts: 0, convertedUrls: 0, notFoundInBucket: 0, complete: false, nextOffset: offset, error: 'Exhausted retries' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const tenantSlug = body.tenant || 'kosterschoenmode';
    const chunkSize = body.chunkSize || 200;
    const maxChunks = body.maxChunks || 20; // safety limit
    const maxRetries = body.maxRetries || 3;

    // Resolve tenant ID
    const { data: tenant } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).single();
    if (!tenant) throw new Error('Tenant not found');

    const startTime = Date.now();
    let offset = 0;
    let totalFixed = 0;
    let totalConverted = 0;
    let totalNotFound = 0;
    let chunksProcessed = 0;
    let errors: string[] = [];
    let complete = false;

    for (let c = 0; c < maxChunks; c++) {
      console.log(`Processing chunk ${c + 1}, offset=${offset}`);
      const result = await runFixChunk(supabaseUrl, anonKey, tenantSlug, offset, chunkSize, 1, maxRetries);

      chunksProcessed++;
      totalFixed += result.fixedProducts;
      totalConverted += result.convertedUrls;
      totalNotFound += result.notFoundInBucket;

      if (!result.success) {
        errors.push(`Chunk offset=${offset}: ${result.error}`);
        // Continue with next offset even on failure
        offset += chunkSize;
        continue;
      }

      if (result.complete || !result.nextOffset) {
        complete = true;
        break;
      }

      offset = result.nextOffset;
    }

    const durationMs = Date.now() - startTime;

    const summary = {
      tenant: tenantSlug,
      chunksProcessed,
      totalFixed,
      totalConverted,
      totalNotFound,
      complete,
      errors: errors.length,
      errorDetails: errors.slice(0, 10),
      durationMs,
      durationSec: Math.round(durationMs / 1000),
    };

    // Log to changelog
    const description = complete
      ? `Auto image fix voltooid: ${totalFixed} producten bijgewerkt, ${totalConverted} URLs geconverteerd, ${totalNotFound} niet gevonden in bucket`
      : `Auto image fix deels voltooid (${chunksProcessed} chunks): ${totalFixed} producten bijgewerkt, ${errors.length} fouten`;

    await supabase.from('changelog').insert({
      tenant_id: tenant.id,
      event_type: totalFixed > 0 ? 'AUTO_IMAGE_FIX' : 'AUTO_IMAGE_FIX_NOOP',
      description,
      metadata: summary,
    });

    console.log('Auto-fix complete:', JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('auto-fix-images error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
