
CREATE OR REPLACE VIEW public.v_sync_status AS
WITH pending_agg AS (
  SELECT
    product_id,
    CASE
      WHEN bool_or(status = 'error') THEN 'error'
      WHEN bool_or(status = 'PENDING') THEN 'pending'
    END as queue_status,
    COALESCE(MAX(attempts), 0) as max_attempts,
    array_agg(DISTINCT sync_scope) FILTER (WHERE sync_scope IS NOT NULL) as sync_scopes,
    MIN(next_retry_at) as next_retry_at
  FROM pending_product_syncs
  WHERE status IN ('PENDING', 'error')
  GROUP BY product_id
)
SELECT
  p.id,
  p.sku,
  p.title,
  p.tenant_id,
  p.dirty_price_stock,
  p.dirty_content,
  p.dirty_taxonomy,
  p.dirty_media,
  p.dirty_variations,
  p.updated_at as modis_updated_at,
  p.woocommerce_product_id,
  wp.woo_id,
  wp.permalink,
  wp.last_pushed_at,
  (wp.product_id IS NOT NULL) as woo_linked,
  pss.last_synced_at,
  pss.last_error,
  pss.last_error_at,
  pss.sync_count,
  pa.queue_status,
  COALESCE(pa.max_attempts, 0) as attempts,
  pa.sync_scopes,
  pa.next_retry_at
FROM products p
LEFT JOIN woo_products wp ON wp.product_id = p.id
LEFT JOIN product_sync_status pss ON pss.product_id = p.id
LEFT JOIN pending_agg pa ON pa.product_id = p.id;

GRANT SELECT ON public.v_sync_status TO authenticated, anon;
