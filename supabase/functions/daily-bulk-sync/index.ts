import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.76.1';

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

    console.log('Starting daily bulk sync...');

    // Get all active tenants
    const { data: tenants, error: tenantsError } = await supabase
      .from('tenants')
      .select('id, name')
      .eq('active', true);

    if (tenantsError) {
      console.error('Error fetching tenants:', tenantsError);
      throw tenantsError;
    }

    console.log(`Found ${tenants?.length || 0} active tenants`);

    let totalJobsCreated = 0;

    // For each tenant, create a bulk sync job
    for (const tenant of tenants || []) {
      // Get all product IDs for this tenant
      const { data: products, error: productsError } = await supabase
        .from('products')
        .select('id')
        .eq('tenant_id', tenant.id);

      if (productsError) {
        console.error(`Error fetching products for tenant ${tenant.name}:`, productsError);
        continue;
      }

      if (!products || products.length === 0) {
        console.log(`No products found for tenant ${tenant.name}`);
        continue;
      }

      const productIds = products.map(p => p.id);
      console.log(`Creating bulk sync job for ${productIds.length} products (tenant: ${tenant.name})`);

      // Create a single bulk sync job for all products
      const { error: jobError } = await supabase
        .from('jobs')
        .insert({
          type: 'SYNC_TO_WOO',
          state: 'ready',
          payload: { productIds },
          tenant_id: tenant.id
        });

      if (jobError) {
        console.error(`Error creating job for tenant ${tenant.name}:`, jobError);
      } else {
        totalJobsCreated++;
        console.log(`✓ Created bulk sync job for tenant ${tenant.name}`);
      }
    }

    console.log(`Daily bulk sync completed. Created ${totalJobsCreated} jobs.`);

    return new Response(
      JSON.stringify({
        success: true,
        tenantsProcessed: tenants?.length || 0,
        jobsCreated: totalJobsCreated
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in daily bulk sync:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
