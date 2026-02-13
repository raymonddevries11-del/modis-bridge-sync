
-- Enable pg_net for HTTP calls from triggers
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Trigger function: call direct-woo-sync on stock change
CREATE OR REPLACE FUNCTION public.trigger_direct_sync_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  product_id_val UUID;
  product_tenant_id UUID;
  supabase_url TEXT;
  anon_key TEXT;
BEGIN
  -- Only fire if qty actually changed
  IF OLD.qty IS NOT DISTINCT FROM NEW.qty THEN
    RETURN NEW;
  END IF;

  -- Get product info from variant
  SELECT v.product_id, p.tenant_id 
  INTO product_id_val, product_tenant_id
  FROM variants v
  JOIN products p ON p.id = v.product_id
  WHERE v.id = NEW.variant_id;

  IF product_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Read Supabase config from env (set via vault or hardcoded)
  supabase_url := current_setting('app.settings.supabase_url', true);
  anon_key := current_setting('app.settings.supabase_anon_key', true);

  -- Fallback: skip if not configured
  IF supabase_url IS NULL OR anon_key IS NULL THEN
    RAISE NOTICE 'Direct sync skipped: app.settings not configured';
    RETURN NEW;
  END IF;

  -- Call direct-woo-sync edge function via pg_net
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/direct-woo-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := jsonb_build_object(
      'tenantId', product_tenant_id,
      'variantIds', jsonb_build_array(NEW.variant_id)
    )
  );

  RETURN NEW;
END;
$$;

-- Trigger function: call direct-woo-sync on price change
CREATE OR REPLACE FUNCTION public.trigger_direct_sync_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  product_tenant_id UUID;
  supabase_url TEXT;
  anon_key TEXT;
BEGIN
  -- Only fire if price actually changed
  IF (OLD.regular IS NOT DISTINCT FROM NEW.regular) AND (OLD.list IS NOT DISTINCT FROM NEW.list) THEN
    RETURN NEW;
  END IF;

  -- Get tenant_id
  SELECT tenant_id INTO product_tenant_id
  FROM products WHERE id = NEW.product_id;

  IF product_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  supabase_url := current_setting('app.settings.supabase_url', true);
  anon_key := current_setting('app.settings.supabase_anon_key', true);

  IF supabase_url IS NULL OR anon_key IS NULL THEN
    RAISE NOTICE 'Direct sync skipped: app.settings not configured';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/direct-woo-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := jsonb_build_object(
      'tenantId', product_tenant_id,
      'priceUpdates', jsonb_build_array(
        jsonb_build_object(
          'productId', NEW.product_id,
          'regularPrice', COALESCE(NEW.regular, 0),
          'listPrice', NEW.list
        )
      )
    )
  );

  RETURN NEW;
END;
$$;

-- Attach triggers
CREATE TRIGGER trg_direct_sync_stock
  AFTER UPDATE OF qty ON public.stock_totals
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_direct_sync_stock();

CREATE TRIGGER trg_direct_sync_price
  AFTER UPDATE ON public.product_prices
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_direct_sync_price();
