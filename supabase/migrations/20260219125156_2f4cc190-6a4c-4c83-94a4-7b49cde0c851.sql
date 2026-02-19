
-- ============================================================
-- Fase 2: Triggers herschrijven voor scope-based syncing
-- ============================================================

-- 2a. trigger_sync_product_prices() herschrijven
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
      -- Scope-based upsert into pending_product_syncs
      INSERT INTO pending_product_syncs (product_id, tenant_id, sync_scope, priority, status, last_seen_at, reason)
      VALUES (NEW.product_id, product_tenant_id, 'PRICE_STOCK', 100, 'PENDING', now(), 'price')
      ON CONFLICT (tenant_id, product_id, sync_scope)
      DO UPDATE SET
        status = 'PENDING',
        attempts = 0,
        next_retry_at = NULL,
        last_seen_at = now(),
        priority = GREATEST(pending_product_syncs.priority, 100);

      -- Set dirty flag on products
      UPDATE products SET
        dirty_price_stock = true,
        updated_at_price_stock = now()
      WHERE id = NEW.product_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2b. trigger_sync_stock_totals() herschrijven
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

    -- Scope-based upsert
    INSERT INTO pending_product_syncs (product_id, tenant_id, sync_scope, priority, status, last_seen_at, reason)
    VALUES (product_id_val, product_tenant_id, 'PRICE_STOCK', 100, 'PENDING', now(), 'stock')
    ON CONFLICT (tenant_id, product_id, sync_scope)
    DO UPDATE SET
      status = 'PENDING',
      attempts = 0,
      next_retry_at = NULL,
      last_seen_at = now(),
      priority = GREATEST(pending_product_syncs.priority, 100);

    -- Set dirty flag
    UPDATE products SET
      dirty_price_stock = true,
      updated_at_price_stock = now()
    WHERE id = product_id_val;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2c. trigger_sync_product_attributes() herschrijven
CREATE OR REPLACE FUNCTION public.trigger_sync_product_attributes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_scope TEXT;
  v_priority INT;
  v_dirty_col TEXT;
BEGIN
  -- Determine scope based on what changed
  IF (OLD.images IS DISTINCT FROM NEW.images) THEN
    v_scope := 'MEDIA';
    v_priority := 40;
    -- Set dirty flags directly
    NEW.dirty_media := true;
    NEW.updated_at_media := now();
  ELSIF (OLD.categories IS DISTINCT FROM NEW.categories) THEN
    v_scope := 'TAXONOMY';
    v_priority := 50;
    NEW.dirty_taxonomy := true;
    NEW.updated_at_taxonomy := now();
  ELSIF (OLD.attributes IS DISTINCT FROM NEW.attributes) THEN
    v_scope := 'CONTENT';
    v_priority := 60;
    NEW.dirty_content := true;
    NEW.updated_at_content := now();
  ELSIF (OLD.title IS DISTINCT FROM NEW.title) OR
        (OLD.webshop_text IS DISTINCT FROM NEW.webshop_text) OR
        (OLD.webshop_text_en IS DISTINCT FROM NEW.webshop_text_en) OR
        (OLD.meta_title IS DISTINCT FROM NEW.meta_title) OR
        (OLD.meta_description IS DISTINCT FROM NEW.meta_description) THEN
    v_scope := 'CONTENT';
    v_priority := 60;
    NEW.dirty_content := true;
    NEW.updated_at_content := now();
  END IF;

  -- Only create pending sync if changes detected
  IF v_scope IS NOT NULL AND NEW.tenant_id IS NOT NULL THEN
    INSERT INTO pending_product_syncs (product_id, tenant_id, sync_scope, priority, status, last_seen_at, reason)
    VALUES (NEW.id, NEW.tenant_id, v_scope, v_priority, 'PENDING', now(), lower(v_scope))
    ON CONFLICT (tenant_id, product_id, sync_scope)
    DO UPDATE SET
      status = 'PENDING',
      attempts = 0,
      next_retry_at = NULL,
      last_seen_at = now(),
      priority = GREATEST(pending_product_syncs.priority, EXCLUDED.priority);

    RAISE NOTICE 'Created pending sync for product % (scope: %)', NEW.id, v_scope;
  END IF;

  RETURN NEW;
END;
$function$;

-- Re-create triggers (drop first to ensure clean state)
DROP TRIGGER IF EXISTS trigger_sync_prices ON public.product_prices;
CREATE TRIGGER trigger_sync_prices
  AFTER UPDATE ON public.product_prices
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_sync_product_prices();

DROP TRIGGER IF EXISTS trigger_sync_stock ON public.stock_totals;
CREATE TRIGGER trigger_sync_stock
  AFTER UPDATE ON public.stock_totals
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_sync_stock_totals();

DROP TRIGGER IF EXISTS trigger_sync_attributes ON public.products;
CREATE TRIGGER trigger_sync_attributes
  BEFORE UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_sync_product_attributes();
