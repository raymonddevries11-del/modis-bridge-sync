
-- Simplify stock trigger: always buffer to pending_product_syncs, never create jobs directly
CREATE OR REPLACE FUNCTION public.trigger_sync_stock_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  product_id_val UUID;
  product_tenant_id UUID;
BEGIN
  IF OLD.qty IS DISTINCT FROM NEW.qty THEN
    SELECT v.product_id, p.tenant_id INTO product_id_val, product_tenant_id
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.id = NEW.variant_id;

    IF product_id_val IS NULL THEN RETURN NEW; END IF;

    INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
    VALUES (product_id_val, product_tenant_id, 'stock', now())
    ON CONFLICT (product_id, reason) DO UPDATE SET created_at = now();
  END IF;
  RETURN NEW;
END;
$function$;

-- Simplify price trigger: always buffer to pending_product_syncs
CREATE OR REPLACE FUNCTION public.trigger_sync_product_prices()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  product_tenant_id UUID;
BEGIN
  IF (OLD.regular IS DISTINCT FROM NEW.regular) OR (OLD.list IS DISTINCT FROM NEW.list) THEN
    SELECT tenant_id INTO product_tenant_id FROM products WHERE id = NEW.product_id;

    IF product_tenant_id IS NOT NULL THEN
      INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
      VALUES (NEW.product_id, product_tenant_id, 'price', now())
      ON CONFLICT (product_id, reason) DO UPDATE SET created_at = now();
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
