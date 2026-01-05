import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('Incremental sync started');

    // Check if there are pending SYNC_TO_WOO jobs
    const { data: pendingJobs, error: jobsError } = await supabase
      .from('jobs')
      .select('id')
      .eq('type', 'SYNC_TO_WOO')
      .in('state', ['ready', 'processing'])
      .limit(1);

    if (jobsError) {
      console.error('Error checking pending jobs:', jobsError);
      throw jobsError;
    }

    if (pendingJobs && pendingJobs.length > 0) {
      console.log('Pending SYNC_TO_WOO jobs exist, skipping this run');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Skipped - pending jobs exist',
        pendingJobs: pendingJobs.length 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get active tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id')
      .eq('active', true)
      .single();

    if (tenantError || !tenant) {
      console.error('Error fetching tenant:', tenantError);
      throw new Error('No active tenant found');
    }

    // Get 50 products that haven't been synced or were synced longest ago
    // Left join with product_sync_status to include products never synced
    const BATCH_SIZE = 50;
    const { data: productsToSync, error: productsError } = await supabase
      .from('products')
      .select(`
        id,
        sku,
        product_sync_status (
          last_synced_at
        )
      `)
      .eq('tenant_id', tenant.id)
      .order('product_sync_status(last_synced_at)', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);

    if (productsError) {
      console.error('Error fetching products:', productsError);
      throw productsError;
    }

    if (!productsToSync || productsToSync.length === 0) {
      console.log('No products to sync');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No products to sync' 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const productIds = productsToSync.map(p => p.id);
    const productSkus = productsToSync.map(p => p.sku);
    
    console.log(`Selected ${productIds.length} products for sync:`, productSkus);

    // Create SYNC_TO_WOO job
    const { data: job, error: insertError } = await supabase
      .from('jobs')
      .insert({
        type: 'SYNC_TO_WOO',
        state: 'ready',
        payload: { productIds },
        tenant_id: tenant.id
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating job:', insertError);
      throw insertError;
    }

    console.log(`Created SYNC_TO_WOO job ${job.id} with ${productIds.length} products`);

    // Update product_sync_status for these products (upsert)
    const syncStatusRecords = productIds.map(id => ({
      product_id: id,
      last_synced_at: new Date().toISOString(),
      sync_count: 1
    }));

    // Use upsert with on_conflict to increment sync_count for existing records
    for (const record of syncStatusRecords) {
      const { error: upsertError } = await supabase
        .from('product_sync_status')
        .upsert(record, { 
          onConflict: 'product_id',
          ignoreDuplicates: false 
        });
      
      if (upsertError) {
        console.error(`Error upserting sync status for ${record.product_id}:`, upsertError);
      }
    }

    // Get total products and synced count for progress
    const { count: totalProducts } = await supabase
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id);

    const { count: syncedProducts } = await supabase
      .from('product_sync_status')
      .select('*', { count: 'exact', head: true });

    const progress = totalProducts ? Math.round((syncedProducts || 0) / totalProducts * 100) : 0;

    console.log(`Sync progress: ${syncedProducts}/${totalProducts} (${progress}%)`);

    return new Response(JSON.stringify({
      success: true,
      message: `Created sync job for ${productIds.length} products`,
      jobId: job.id,
      products: productSkus,
      progress: {
        synced: syncedProducts || 0,
        total: totalProducts || 0,
        percentage: progress
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('Incremental sync error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: errorMessage 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
