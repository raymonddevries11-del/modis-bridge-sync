import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    console.log('Running health check...');

    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {} as Record<string, any>,
    };

    // Check database connection
    try {
      const { error: dbError } = await supabase
        .from('config')
        .select('key')
        .limit(1);
      
      health.checks.database = dbError ? { status: 'unhealthy', error: dbError.message } : { status: 'healthy' };
    } catch (error: any) {
      health.checks.database = { status: 'unhealthy', error: error.message };
    }

    // Check SFTP configuration (via GitHub Actions)
    try {
      const { data: configData, error: configError } = await supabase
        .from('config')
        .select('value')
        .eq('key', 'sftp')
        .single();

      if (configError || !configData) {
        health.checks.sftp_config = { status: 'not_configured' };
      } else {
        health.checks.sftp_config = { 
          status: 'configured',
          note: 'SFTP processing via GitHub Actions',
        };
      }
    } catch (error: any) {
      health.checks.sftp_config = { status: 'error', error: error.message };
    }

    // Check WooCommerce configuration
    try {
      const { data: wooConfig } = await supabase
        .from('config')
        .select('value')
        .eq('key', 'woocommerce')
        .single();

      health.checks.woocommerce = wooConfig?.value ? { status: 'configured' } : { status: 'not_configured' };
    } catch (error: any) {
      health.checks.woocommerce = { status: 'error', error: error.message };
    }

    // Check job queue statistics
    try {
      const { data: jobs } = await supabase
        .from('jobs')
        .select('state,type')
        .limit(1000);

      const stats = jobs?.reduce((acc, job) => {
        acc[job.state] = (acc[job.state] || 0) + 1;
        return acc;
      }, {} as Record<string, number>) || {};

      health.checks.job_queue = {
        status: 'healthy',
        stats: stats,
      };
    } catch (error: any) {
      health.checks.job_queue = { status: 'error', error: error.message };
    }

    // Check table counts
    try {
      const [products, orders, variants] = await Promise.all([
        supabase.from('products').select('id', { count: 'exact', head: true }),
        supabase.from('orders').select('order_number', { count: 'exact', head: true }),
        supabase.from('variants').select('id', { count: 'exact', head: true }),
      ]);

      health.checks.data_stats = {
        products: products.count || 0,
        orders: orders.count || 0,
        variants: variants.count || 0,
      };
    } catch (error: any) {
      health.checks.data_stats = { status: 'error', error: error.message };
    }

    // Overall health status
    const hasUnhealthy = Object.values(health.checks).some(
      (check: any) => check.status === 'unhealthy' || check.status === 'error'
    );
    
    if (hasUnhealthy) {
      health.status = 'degraded';
    }

    console.log('Health check complete:', health.status);

    return new Response(
      JSON.stringify(health),
      { 
        status: health.status === 'healthy' ? 200 : 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error: any) {
    console.error('Error in health check:', error);
    
    return new Response(
      JSON.stringify({ 
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
