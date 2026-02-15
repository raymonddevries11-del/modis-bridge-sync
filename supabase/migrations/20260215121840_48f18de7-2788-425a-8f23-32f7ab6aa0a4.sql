
-- Drop old direct-call triggers and functions (CASCADE to handle dependencies)
DROP TRIGGER IF EXISTS trg_direct_sync_stock ON public.stock_totals;
DROP TRIGGER IF EXISTS trg_direct_sync_price ON public.product_prices;
DROP TRIGGER IF EXISTS trigger_direct_sync_stock ON public.stock_totals;
DROP TRIGGER IF EXISTS trigger_direct_sync_price ON public.product_prices;
DROP FUNCTION IF EXISTS public.trigger_direct_sync_stock() CASCADE;
DROP FUNCTION IF EXISTS public.trigger_direct_sync_price() CASCADE;

-- Drop old job-creating triggers
DROP TRIGGER IF EXISTS trigger_sync_stock_totals ON public.stock_totals;
DROP TRIGGER IF EXISTS trigger_sync_product_prices ON public.product_prices;

-- Create queue-only trigger: stock changes → pending_product_syncs
CREATE OR REPLACE FUNCTION public.queue_stock_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  product_id_val UUID;
  product_tenant_id UUID;
BEGIN
  IF OLD.qty IS NOT DISTINCT FROM NEW.qty THEN
    RETURN NEW;
  END IF;

  SELECT v.product_id, p.tenant_id
  INTO product_id_val, product_tenant_id
  FROM variants v
  JOIN products p ON p.id = v.product_id
  WHERE v.id = NEW.variant_id;

  IF product_tenant_id IS NOT NULL THEN
    INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
    VALUES (product_id_val, product_tenant_id, 'stock', now())
    ON CONFLICT (product_id, reason)
    DO UPDATE SET created_at = now();
  END IF;

  RETURN NEW;
END;
$$;

-- Create queue-only trigger: price changes → pending_product_syncs
CREATE OR REPLACE FUNCTION public.queue_price_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  product_tenant_id UUID;
BEGIN
  IF (OLD.regular IS NOT DISTINCT FROM NEW.regular) AND (OLD.list IS NOT DISTINCT FROM NEW.list) THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO product_tenant_id
  FROM products WHERE id = NEW.product_id;

  IF product_tenant_id IS NOT NULL THEN
    INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
    VALUES (NEW.product_id, product_tenant_id, 'price', now())
    ON CONFLICT (product_id, reason)
    DO UPDATE SET created_at = now();
  END IF;

  RETURN NEW;
END;
$$;

-- Attach new queue triggers
CREATE TRIGGER queue_stock_sync_trigger
  AFTER UPDATE ON public.stock_totals
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_stock_sync();

CREATE TRIGGER queue_price_sync_trigger
  AFTER UPDATE ON public.product_prices
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_price_sync();
