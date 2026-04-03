
-- Update housekeep_jobs to also recover stale DRAINING items and orphaned dirty products
CREATE OR REPLACE FUNCTION public.housekeep_jobs()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  stuck_count INTEGER;
  purged_done INTEGER;
  purged_error INTEGER;
  draining_reset INTEGER;
  orphan_count INTEGER;
BEGIN
  -- 1. Move stuck processing jobs (>15 min) to error
  UPDATE jobs
  SET state = 'error',
      error = 'Housekeeper: stuck in processing beyond 15 min threshold',
      updated_at = now()
  WHERE state = 'processing'
    AND updated_at < now() - interval '15 minutes';
  GET DIAGNOSTICS stuck_count = ROW_COUNT;

  -- 2. Purge completed jobs older than 1 day
  DELETE FROM jobs
  WHERE state = 'done'
    AND updated_at < now() - interval '1 day';
  GET DIAGNOSTICS purged_done = ROW_COUNT;

  -- 3. Purge error jobs older than 7 days
  DELETE FROM jobs
  WHERE state = 'error'
    AND updated_at < now() - interval '7 days';
  GET DIAGNOSTICS purged_error = ROW_COUNT;

  -- 4. Reset stale DRAINING items back to PENDING (stuck > 15 min)
  UPDATE pending_product_syncs
  SET status = 'PENDING',
      locked_at = NULL,
      locked_by = NULL,
      last_seen_at = now()
  WHERE status = 'DRAINING'
    AND locked_at < now() - interval '15 minutes';
  GET DIAGNOSTICS draining_reset = ROW_COUNT;

  -- 5. Re-queue orphaned dirty products (dirty flag set but no pending sync entry)
  INSERT INTO pending_product_syncs (product_id, tenant_id, sync_scope, priority, status, last_seen_at, reason)
  SELECT p.id, p.tenant_id,
    CASE 
      WHEN p.dirty_price_stock THEN 'PRICE_STOCK'
      WHEN p.dirty_content THEN 'CONTENT'
      WHEN p.dirty_taxonomy THEN 'TAXONOMY'
      WHEN p.dirty_media THEN 'MEDIA'
    END,
    50, 'PENDING', now(), 'housekeep_orphan'
  FROM products p
  WHERE (p.dirty_price_stock OR p.dirty_content OR p.dirty_taxonomy OR p.dirty_media)
    AND p.tenant_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pending_product_syncs pps 
      WHERE pps.product_id = p.id
    )
  ON CONFLICT (tenant_id, product_id, sync_scope) DO NOTHING;
  GET DIAGNOSTICS orphan_count = ROW_COUNT;

  RAISE NOTICE 'Housekeeper: % stuck reset, % done purged, % error purged, % draining reset, % orphans re-queued', 
    stuck_count, purged_done, purged_error, draining_reset, orphan_count;
END;
$function$;
