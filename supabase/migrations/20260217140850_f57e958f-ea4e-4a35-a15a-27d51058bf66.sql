
-- 1. Add computed hash column for deduplication
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS payload_hash text
  GENERATED ALWAYS AS (md5(type || ':' || payload::text)) STORED;

-- 2. Partial unique index: only one ready/processing job per type+payload combo
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
  ON public.jobs (payload_hash)
  WHERE state IN ('ready', 'processing');

-- 3. Dedupe utility function
CREATE OR REPLACE FUNCTION public.dedupe_sync_jobs()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  removed INTEGER;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY payload_hash ORDER BY created_at ASC) AS rn
    FROM jobs
    WHERE state = 'ready' AND type = 'SYNC_TO_WOO'
  )
  DELETE FROM jobs WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

-- 4. Idempotent triggers with backpressure
CREATE OR REPLACE FUNCTION public.trigger_sync_product_prices()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  queue_size INTEGER;
  product_tenant_id UUID;
  max_queue INTEGER := 100;
BEGIN
  IF (OLD.regular IS DISTINCT FROM NEW.regular) OR (OLD.list IS DISTINCT FROM NEW.list) THEN
    SELECT tenant_id INTO product_tenant_id FROM products WHERE id = NEW.product_id;

    SELECT COUNT(*) INTO queue_size FROM jobs WHERE state IN ('ready', 'processing');
    IF queue_size >= max_queue THEN
      IF product_tenant_id IS NOT NULL THEN
        INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
        VALUES (NEW.product_id, product_tenant_id, 'price', now())
        ON CONFLICT (product_id, reason) DO UPDATE SET created_at = now();
      END IF;
      RETURN NEW;
    END IF;

    BEGIN
      INSERT INTO jobs (type, state, payload, tenant_id)
      VALUES ('SYNC_TO_WOO', 'ready',
        jsonb_build_object('productIds', jsonb_build_array(NEW.product_id)),
        product_tenant_id);
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
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
  queue_size INTEGER;
  product_id_val UUID;
  product_tenant_id UUID;
  max_queue INTEGER := 100;
BEGIN
  IF OLD.qty IS DISTINCT FROM NEW.qty THEN
    SELECT v.product_id, p.tenant_id INTO product_id_val, product_tenant_id
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.id = NEW.variant_id;

    IF product_id_val IS NULL THEN RETURN NEW; END IF;

    SELECT COUNT(*) INTO queue_size FROM jobs WHERE state IN ('ready', 'processing');
    IF queue_size >= max_queue THEN
      INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
      VALUES (product_id_val, product_tenant_id, 'stock', now())
      ON CONFLICT (product_id, reason) DO UPDATE SET created_at = now();
      RETURN NEW;
    END IF;

    BEGIN
      INSERT INTO jobs (type, state, payload, tenant_id)
      VALUES ('SYNC_TO_WOO', 'ready',
        jsonb_build_object('variantIds', jsonb_build_array(NEW.variant_id)),
        product_tenant_id);
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$function$;
