import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * SFTP Watcher – scans /modis-to-wp/ready for complete files and queues jobs.
 * 
 * This function is called periodically by pg_cron. It does NOT connect to SFTP
 * directly (edge functions can't use ssh2). Instead it uses the Supabase REST API
 * to list files that have been placed in a "ready" staging table by GitHub Actions,
 * OR it simply creates SFTP_SCAN jobs that GitHub Actions will pick up.
 * 
 * Flow:
 * 1. List pending files from sftp_ready_files table
 * 2. For each file, create a typed job (ARTICLE_IMPORT, STOCK_IMPORT, CSV_IMPORT)
 * 3. Mark file as queued
 * 
 * Alternative flow (without sftp_ready_files table):
 * 1. Create a single SFTP_SCAN job per tenant
 * 2. GitHub Actions picks up SFTP_SCAN jobs and processes /ready folder
 */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Get all active tenants with config
    const { data: tenants, error: tenantError } = await supabase
      .from('tenants')
      .select('id, name, slug')
      .eq('active', true);

    if (tenantError) throw tenantError;

    const { data: configs } = await supabase
      .from('tenant_config')
      .select('tenant_id, sftp_inbound_path');

    const configMap = new Map<string, string>();
    for (const c of (configs || [])) {
      if (c.sftp_inbound_path) {
        configMap.set(c.tenant_id, c.sftp_inbound_path);
      }
    }

    const results: { tenant: string; jobsCreated: number; skipped: number }[] = [];

    for (const tenant of (tenants || [])) {
      const basePath = configMap.get(tenant.id);
      if (!basePath) continue;

      const readyPath = `${basePath}/ready`;

      // Check if there's already a pending SFTP_SCAN job for this tenant (debounce)
      const { data: existingJobs } = await supabase
        .from('jobs')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('type', 'SFTP_SCAN')
        .in('state', ['ready', 'processing'])
        .limit(1);

      if (existingJobs && existingJobs.length > 0) {
        results.push({ tenant: tenant.name, jobsCreated: 0, skipped: 1 });
        continue;
      }

      // Create SFTP_SCAN job for GitHub Actions to pick up
      const { error: jobError } = await supabase
        .from('jobs')
        .insert({
          type: 'SFTP_SCAN',
          state: 'ready',
          tenant_id: tenant.id,
          payload: {
            scan_path: readyPath,
            base_path: basePath,
            tenant_slug: tenant.slug,
            file_types: ['artikel', 'voorraad', 'products'],
            created_by: 'sftp-watcher',
          },
        });

      if (jobError) {
        console.error(`Error creating job for ${tenant.name}:`, jobError.message);
        results.push({ tenant: tenant.name, jobsCreated: 0, skipped: 0 });
      } else {
        console.log(`Created SFTP_SCAN job for ${tenant.name} → ${readyPath}`);
        results.push({ tenant: tenant.name, jobsCreated: 1, skipped: 0 });
      }
    }

    // Log to changelog if any jobs were created
    const totalJobs = results.reduce((sum, r) => sum + r.jobsCreated, 0);
    if (totalJobs > 0) {
      const tenantWithJobs = results.find(r => r.jobsCreated > 0);
      const tenantId = (tenants || []).find(t => t.name === tenantWithJobs?.tenant)?.id;
      if (tenantId) {
        await supabase.from('changelog').insert({
          tenant_id: tenantId,
          event_type: 'SFTP_SCAN_QUEUED',
          description: `SFTP watcher: ${totalJobs} scan job(s) aangemaakt voor /ready folder`,
          metadata: { results },
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Scanned ${results.length} tenants, created ${totalJobs} SFTP_SCAN jobs`,
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('SFTP Watcher error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
