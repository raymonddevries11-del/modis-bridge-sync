
-- Replace trigger functions with hardcoded Supabase URL and anon key

CREATE OR REPLACE FUNCTION public.trigger_direct_sync_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  product_id_val UUID;
  product_tenant_id UUID;
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

  -- Call direct-woo-sync edge function via pg_net
  PERFORM net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/direct-woo-sync',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo"}'::jsonb,
    body := jsonb_build_object(
      'tenantId', product_tenant_id,
      'variantIds', jsonb_build_array(NEW.variant_id)
    )
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_direct_sync_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  product_tenant_id UUID;
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

  PERFORM net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/direct-woo-sync',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo"}'::jsonb,
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
