import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Idempotent order reconciliation:
 * 1. Finds all ACKed exports not yet reconciled
 * 2. Validates each: order exists, XML in storage matches, order_number consistent
 * 3. Computes a reconciliation hash (order_number + filename + storage_path)
 * 4. Marks as reconciled only if validation passes (skips if already reconciled via hash)
 * 5. Archives the storage file to an /archive/ prefix
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const dryRun = body.dry_run === true;
    const specificOrder = body.order_number as string | undefined;

    // Fetch ACKed but not yet reconciled exports
    let query = supabase
      .from('export_files')
      .select('*')
      .eq('ack_status', 'acked')
      .is('reconciled_at', null)
      .order('created_at', { ascending: true })
      .limit(200);

    if (specificOrder) {
      query = query.eq('order_number', specificOrder);
    }

    const { data: exports, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;

    if (!exports || exports.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No ACKed exports pending reconciliation',
        reconciled: 0,
        failed: 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log(`Reconciling ${exports.length} ACKed exports (dry_run=${dryRun})`);

    let reconciled = 0;
    let failed = 0;
    let skipped = 0;
    const failures: Array<{ order_number: string; reason: string }> = [];

    for (const exp of exports) {
      try {
        // --- Idempotency check via hash ---
        const hash = await computeHash(`${exp.order_number}:${exp.filename}:${exp.storage_path}`);
        if (exp.reconciliation_hash === hash) {
          skipped++;
          continue;
        }

        // --- Validation 1: Order still exists in DB ---
        const { data: order, error: orderErr } = await supabase
          .from('orders')
          .select('order_number, status, tenant_id')
          .eq('order_number', exp.order_number)
          .maybeSingle();

        if (orderErr || !order) {
          failures.push({ order_number: exp.order_number, reason: 'Order not found in database' });
          failed++;
          continue;
        }

        // --- Validation 2: Tenant consistency ---
        if (exp.tenant_id && order.tenant_id && exp.tenant_id !== order.tenant_id) {
          failures.push({ order_number: exp.order_number, reason: 'Tenant mismatch between export and order' });
          failed++;
          continue;
        }

        // --- Validation 3: XML file exists in storage ---
        const { data: fileData } = await supabase
          .storage
          .from('order-exports')
          .download(exp.storage_path);

        if (!fileData) {
          failures.push({ order_number: exp.order_number, reason: 'XML file missing from storage' });
          failed++;
          continue;
        }

        // --- Validation 4: XML content contains matching order number ---
        const xmlContent = await fileData.text();
        if (!xmlContent.includes(`<ordernummer>${exp.order_number}</ordernummer>`)) {
          failures.push({ order_number: exp.order_number, reason: 'XML content does not match order number' });
          failed++;
          continue;
        }

        // --- All validations passed ---
        if (dryRun) {
          console.log(`[DRY RUN] Would reconcile ${exp.order_number}`);
          reconciled++;
          continue;
        }

        // Archive: copy to archive/ prefix, keep original for safety
        const archivePath = `archive/${exp.storage_path}`;
        const { error: copyErr } = await supabase
          .storage
          .from('order-exports')
          .copy(exp.storage_path, archivePath);

        if (copyErr && !copyErr.message?.includes('already exists')) {
          console.warn(`Archive copy warning for ${exp.order_number}: ${copyErr.message}`);
          // Non-fatal: proceed with reconciliation even if archive copy fails
        }

        // Mark as reconciled with hash
        const now = new Date().toISOString();
        const { error: updateErr } = await supabase
          .from('export_files')
          .update({
            ack_status: 'reconciled',
            reconciled_at: now,
            reconciliation_hash: hash,
            archived_at: now,
          })
          .eq('id', exp.id)
          .is('reconciled_at', null); // Extra idempotency guard

        if (updateErr) {
          console.error(`Failed to update ${exp.order_number}: ${updateErr.message}`);
          failed++;
          continue;
        }

        // Log to changelog
        await supabase
          .from('changelog')
          .insert({
            tenant_id: exp.tenant_id || order.tenant_id,
            event_type: 'ORDER_RECONCILED',
            description: `Order ${exp.order_number} gevalideerd en gearchiveerd`,
            metadata: {
              filename: exp.filename,
              order_number: exp.order_number,
              reconciliation_hash: hash,
              archive_path: archivePath,
            },
          });

        // Remove original from active storage (keep archive)
        await supabase.storage.from('order-exports').remove([exp.storage_path]);

        reconciled++;
        console.log(`✓ Reconciled ${exp.order_number}`);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error reconciling ${exp.order_number}: ${msg}`);
        failures.push({ order_number: exp.order_number, reason: msg });
        failed++;
      }
    }

    const result = {
      success: true,
      dry_run: dryRun,
      total: exports.length,
      reconciled,
      failed,
      skipped,
      failures: failures.length > 0 ? failures : undefined,
    };

    console.log('Reconciliation complete:', JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Reconciliation error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function computeHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
