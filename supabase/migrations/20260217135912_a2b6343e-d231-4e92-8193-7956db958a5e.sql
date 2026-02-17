
-- Add backpressure: skip job creation when queue exceeds threshold
CREATE OR REPLACE FUNCTION public.trigger_sync_product_prices()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  existing_job_count INTEGER;
  queue_size INTEGER;
  product_tenant_id UUID;
  max_queue INTEGER := 100;
BEGIN
  IF (OLD.regular IS DISTINCT FROM NEW.regular) OR (OLD.list IS DISTINCT FROM NEW.list) THEN
    -- Backpressure: check queue size
    SELECT COUNT(*) INTO queue_size
    FROM jobs
    WHERE state IN ('ready', 'processing');

    IF queue_size >= max_queue THEN
      RAISE NOTICE 'Backpressure: queue at % (limit %), skipping price sync job for product %', queue_size, max_queue, NEW.product_id;
      -- Still record in pending_product_syncs so batch-woo-sync picks it up later
      SELECT tenant_id INTO product_tenant_id FROM products WHERE id = NEW.product_id;
      IF product_tenant_id IS NOT NULL THEN
        INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
        VALUES (NEW.product_id, product_tenant_id, 'price', now())
        ON CONFLICT (product_id, reason) DO UPDATE SET created_at = now();
      END IF;
      RETURN NEW;
    END IF;

    SELECT tenant_id INTO product_tenant_id FROM products WHERE id = NEW.product_id;

    SELECT COUNT(*) INTO existing_job_count
    FROM jobs
    WHERE type = 'SYNC_TO_WOO'
      AND state IN ('ready', 'processing')
      AND payload @> jsonb_build_object('productIds', jsonb_build_array(NEW.product_id))
      AND created_at > NOW() - INTERVAL '30 minutes';

    IF existing_job_count = 0 THEN
      INSERT INTO jobs (type, state, payload, tenant_id)
      VALUES (
        'SYNC_TO_WOO', 'ready',
        jsonb_build_object('productIds', jsonb_build_array(NEW.product_id)),
        product_tenant_id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_sync_stock_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  existing_job_count INTEGER;
  queue_size INTEGER;
  product_id_val UUID;
  product_tenant_id UUID;
  max_queue INTEGER := 100;
BEGIN
  IF OLD.qty IS DISTINCT FROM NEW.qty THEN
    -- Backpressure: check queue size
    SELECT COUNT(*) INTO queue_size
    FROM jobs
    WHERE state IN ('ready', 'processing');

    IF queue_size >= max_queue THEN
      SELECT v.product_id, p.tenant_id INTO product_id_val, product_tenant_id
      FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = NEW.variant_id;

      IF product_id_val IS NOT NULL THEN
        RAISE NOTICE 'Backpressure: queue at % (limit %), skipping stock sync job for variant %', queue_size, max_queue, NEW.variant_id;
        INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
        VALUES (product_id_val, product_tenant_id, 'stock', now())
        ON CONFLICT (product_id, reason) DO UPDATE SET created_at = now();
      END IF;
      RETURN NEW;
    END IF;

    SELECT v.product_id, p.tenant_id INTO product_id_val, product_tenant_id
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.id = NEW.variant_id;

    IF product_id_val IS NOT NULL THEN
      SELECT COUNT(*) INTO existing_job_count
      FROM jobs
      WHERE type = 'SYNC_TO_WOO'
        AND state IN ('ready', 'processing')
        AND payload @> jsonb_build_object('variantIds', jsonb_build_array(NEW.variant_id))
        AND created_at > NOW() - INTERVAL '30 minutes';

      IF existing_job_count = 0 THEN
        INSERT INTO jobs (type, state, payload, tenant_id)
        VALUES (
          'SYNC_TO_WOO', 'ready',
          jsonb_build_object('variantIds', jsonb_build_array(NEW.variant_id)),
          product_tenant_id
        );
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
