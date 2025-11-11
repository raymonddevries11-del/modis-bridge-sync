-- Disable de huidige triggers die te veel jobs aanmaken
DROP TRIGGER IF EXISTS sync_product_prices_trigger ON product_prices;
DROP TRIGGER IF EXISTS sync_stock_totals_trigger ON stock_totals;

-- Maak een tabel om gewijzigde producten bij te houden (debouncing buffer)
CREATE TABLE IF NOT EXISTS pending_product_syncs (
  product_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  reason TEXT NOT NULL, -- 'price' of 'stock'
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, reason)
);

-- Nieuwe lightweight trigger die alleen registreert welke producten gewijzigd zijn
CREATE OR REPLACE FUNCTION track_product_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  product_tenant_id UUID;
  change_reason TEXT;
BEGIN
  -- Bepaal de reden van wijziging
  IF TG_TABLE_NAME = 'product_prices' THEN
    change_reason := 'price';
    SELECT tenant_id INTO product_tenant_id
    FROM products WHERE id = NEW.product_id;
  ELSIF TG_TABLE_NAME = 'stock_totals' THEN
    change_reason := 'stock';
    SELECT p.tenant_id INTO product_tenant_id
    FROM variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.id = NEW.variant_id;
  END IF;

  -- Registreer de wijziging (INSERT ... ON CONFLICT UPDATE timestamp)
  INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
  SELECT 
    CASE 
      WHEN TG_TABLE_NAME = 'product_prices' THEN NEW.product_id
      ELSE v.product_id
    END,
    product_tenant_id,
    change_reason,
    now()
  FROM (SELECT NEW.variant_id) x
  LEFT JOIN variants v ON v.id = x.variant_id
  WHERE TG_TABLE_NAME = 'stock_totals' OR TG_TABLE_NAME = 'product_prices'
  ON CONFLICT (product_id, reason) 
  DO UPDATE SET created_at = now();

  RETURN NEW;
END;
$function$;

-- Maak triggers die alleen wijzigingen registreren (geen jobs)
CREATE TRIGGER track_price_changes
AFTER UPDATE ON product_prices
FOR EACH ROW
WHEN (OLD.regular IS DISTINCT FROM NEW.regular OR OLD.list IS DISTINCT FROM NEW.list)
EXECUTE FUNCTION track_product_change();

CREATE TRIGGER track_stock_changes
AFTER UPDATE ON stock_totals
FOR EACH ROW
WHEN (OLD.qty IS DISTINCT FROM NEW.qty)
EXECUTE FUNCTION track_product_change();

-- Maak een functie om batch sync jobs te creëren
CREATE OR REPLACE FUNCTION create_batch_sync_jobs()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  tenant_record RECORD;
  product_ids UUID[];
BEGIN
  -- Voor elke tenant, maak een batch job met alle pending products
  FOR tenant_record IN 
    SELECT DISTINCT tenant_id 
    FROM pending_product_syncs 
    WHERE created_at < now() - INTERVAL '30 seconds' -- Debounce window van 30 seconden
  LOOP
    -- Verzamel alle product IDs voor deze tenant
    SELECT array_agg(DISTINCT product_id) INTO product_ids
    FROM pending_product_syncs
    WHERE tenant_id = tenant_record.tenant_id
      AND created_at < now() - INTERVAL '30 seconds';

    -- Maak 1 batch job voor alle producten
    IF array_length(product_ids, 1) > 0 THEN
      INSERT INTO jobs (type, state, payload, tenant_id)
      VALUES (
        'SYNC_TO_WOO',
        'ready',
        jsonb_build_object('productIds', to_jsonb(product_ids)),
        tenant_record.tenant_id
      );

      -- Verwijder de verwerkte producten
      DELETE FROM pending_product_syncs
      WHERE tenant_id = tenant_record.tenant_id
        AND created_at < now() - INTERVAL '30 seconds';

      RAISE NOTICE 'Created batch SYNC_TO_WOO job for % products (tenant %)', array_length(product_ids, 1), tenant_record.tenant_id;
    END IF;
  END LOOP;
END;
$function$;

-- Schedule de batch job functie om elke minuut te draaien
SELECT cron.schedule(
  'create-batch-sync-jobs',
  '* * * * *', -- Elke minuut
  $$SELECT create_batch_sync_jobs();$$
);