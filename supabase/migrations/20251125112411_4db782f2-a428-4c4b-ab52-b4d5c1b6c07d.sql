-- Fix track_product_change function to properly handle stock_totals updates
CREATE OR REPLACE FUNCTION public.track_product_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  product_tenant_id UUID;
  change_reason TEXT;
  target_product_id UUID;
BEGIN
  -- Bepaal de reden van wijziging en product_id
  IF TG_TABLE_NAME = 'product_prices' THEN
    change_reason := 'price';
    target_product_id := NEW.product_id;
    SELECT tenant_id INTO product_tenant_id
    FROM products WHERE id = NEW.product_id;
  ELSIF TG_TABLE_NAME = 'stock_totals' THEN
    change_reason := 'stock';
    SELECT p.id, p.tenant_id INTO target_product_id, product_tenant_id
    FROM variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.id = NEW.variant_id;
  END IF;

  -- Registreer de wijziging
  IF target_product_id IS NOT NULL THEN
    INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
    VALUES (target_product_id, product_tenant_id, change_reason, now())
    ON CONFLICT (product_id, reason) 
    DO UPDATE SET created_at = now();
  END IF;

  RETURN NEW;
END;
$function$;