-- For duplicate woo_products entries (same tenant_id + sku), keep only the one with the highest woo_id
-- (which is the most recent WooCommerce product) and delete the older ones.
-- Also update products.woocommerce_product_id to match the kept entry.

-- Step 1: Delete the OLD duplicate entries (keep the one with MAX woo_id per tenant+sku)
WITH ranked AS (
  SELECT id, tenant_id, sku, woo_id, product_id,
    ROW_NUMBER() OVER (PARTITION BY tenant_id, sku ORDER BY woo_id DESC) AS rn
  FROM woo_products
  WHERE sku IS NOT NULL
),
dupes_to_delete AS (
  SELECT id FROM ranked WHERE rn > 1
)
DELETE FROM woo_products WHERE id IN (SELECT id FROM dupes_to_delete);

-- Step 2: Update products.woocommerce_product_id to the correct (kept) woo_id
UPDATE products p
SET woocommerce_product_id = wp.woo_id
FROM woo_products wp
WHERE wp.product_id = p.id
  AND wp.tenant_id = p.tenant_id
  AND (p.woocommerce_product_id IS DISTINCT FROM wp.woo_id);