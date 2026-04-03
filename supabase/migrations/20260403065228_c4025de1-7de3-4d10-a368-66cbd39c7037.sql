
-- One-time recovery of orphaned dirty products
INSERT INTO pending_product_syncs (product_id, tenant_id, sync_scope, priority, status, last_seen_at, reason)
SELECT p.id, p.tenant_id, 'PRICE_STOCK', 50, 'PENDING', now(), 'orphan_recovery'
FROM products p
WHERE p.dirty_price_stock = true
  AND p.tenant_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pending_product_syncs pps WHERE pps.product_id = p.id AND pps.sync_scope = 'PRICE_STOCK')
ON CONFLICT (tenant_id, product_id, sync_scope) DO NOTHING;

INSERT INTO pending_product_syncs (product_id, tenant_id, sync_scope, priority, status, last_seen_at, reason)
SELECT p.id, p.tenant_id, 'MEDIA', 40, 'PENDING', now(), 'orphan_recovery'
FROM products p
WHERE p.dirty_media = true
  AND p.tenant_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pending_product_syncs pps WHERE pps.product_id = p.id AND pps.sync_scope = 'MEDIA')
ON CONFLICT (tenant_id, product_id, sync_scope) DO NOTHING;
