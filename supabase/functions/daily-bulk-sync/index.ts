import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Manual repair-only mode — NOT scheduled via cron.
    // Call this manually to force a full reconciliation for a tenant.
    let targetTenantId: string | null = null;
    let dryRun = false;
    try {
      const body = await req.json();
      targetTenantId = body?.tenantId || null;
      dryRun = body?.dryRun === true;
    } catch { /* no body */ }

    if (!targetTenantId) {
      return new Response(
        JSON.stringify({ error: 'tenantId is required. This is a manual repair tool, not a scheduled job.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    console.log(`Starting manual repair sync for tenant ${targetTenantId} (dryRun: ${dryRun})...`);

    // Get active tenants
    let tenantsQuery = supabase.from('tenants').select('id, name').eq('active', true);
    if (targetTenantId) {
      tenantsQuery = tenantsQuery.eq('id', targetTenantId);
    }

    const { data: tenants, error: tenantsError } = await tenantsQuery;
    if (tenantsError) throw tenantsError;

    console.log(`Processing ${tenants?.length || 0} tenant(s) for repair`);

    let totalProductsFlagged = 0;

    for (const tenant of tenants || []) {
      // Set all dirty flags to true for this tenant's products
      // This will cause the normal drain-pending-syncs cycle to pick them up
      const { data: products, error: productsError } = await supabase
        .from('products')
        .select('id')
        .eq('tenant_id', tenant.id);

      if (productsError) {
        console.error(`Error fetching products for tenant ${tenant.name}:`, productsError);
        continue;
      }

      if (!products || products.length === 0) {
        console.log(`No products for tenant ${tenant.name}`);
        continue;
      }

      // Update dirty flags in batches
      const productIds = products.map(p => p.id);
      for (let i = 0; i < productIds.length; i += 500) {
        const chunk = productIds.slice(i, i + 500);
        await supabase
          .from('products')
          .update({
            dirty_price_stock: true,
            dirty_content: true,
            dirty_taxonomy: true,
            dirty_media: true,
            updated_at_price_stock: new Date().toISOString(),
            updated_at_content: new Date().toISOString(),
            updated_at_taxonomy: new Date().toISOString(),
            updated_at_media: new Date().toISOString(),
          })
          .in('id', chunk);
      }

      // Insert pending syncs for each scope (triggers will be picked up by drain)
      const scopes = [
        { scope: 'PRICE_STOCK', priority: 100 },
        { scope: 'CONTENT', priority: 60 },
        { scope: 'TAXONOMY', priority: 50 },
        { scope: 'MEDIA', priority: 40 },
      ];

      for (const { scope, priority } of scopes) {
        for (let i = 0; i < productIds.length; i += 200) {
          const chunk = productIds.slice(i, i + 200);
          const rows = chunk.map(pid => ({
            tenant_id: tenant.id,
            product_id: pid,
            sync_scope: scope,
            priority,
            status: 'PENDING',
            last_seen_at: new Date().toISOString(),
            reason: 'repair',
          }));

          // Upsert to avoid conflicts
          await supabase
            .from('pending_product_syncs')
            .upsert(rows, { onConflict: 'tenant_id,product_id,sync_scope' });
        }
      }

      totalProductsFlagged += productIds.length;
      console.log(`✓ Flagged ${productIds.length} products for repair (tenant: ${tenant.name})`);
    }

    console.log(`Repair sync complete. ${totalProductsFlagged} products flagged across ${tenants?.length || 0} tenants.`);

    return new Response(
      JSON.stringify({
        success: true,
        mode: 'repair',
        tenantsProcessed: tenants?.length || 0,
        productsFlagged: totalProductsFlagged,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (error) {
    console.error('Error in repair sync:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
