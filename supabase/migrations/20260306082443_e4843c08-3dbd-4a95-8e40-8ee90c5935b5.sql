UPDATE woo_products wp
SET product_id = p.id, updated_at = now()
FROM products p
WHERE p.sku = wp.sku
  AND p.tenant_id = wp.tenant_id
  AND wp.product_id IS NULL
  AND wp.sku IS NOT NULL;