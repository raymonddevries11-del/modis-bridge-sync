-- Fix trigger to include tenant_id when creating SYNC_TO_WOO jobs
CREATE OR REPLACE FUNCTION public.trigger_sync_product_prices()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  existing_job_count INTEGER;
  product_tenant_id UUID;
BEGIN
  -- Only create job if price actually changed
  IF (OLD.regular IS DISTINCT FROM NEW.regular) OR (OLD.list IS DISTINCT FROM NEW.list) THEN
    -- Get tenant_id from the product
    SELECT tenant_id INTO product_tenant_id
    FROM products
    WHERE id = NEW.product_id;
    
    -- Check if there's already a pending job for this product (debouncing)
    SELECT COUNT(*) INTO existing_job_count
    FROM jobs
    WHERE type = 'SYNC_TO_WOO'
      AND state IN ('ready', 'processing')
      AND payload @> jsonb_build_object('productIds', jsonb_build_array(NEW.product_id))
      AND created_at > NOW() - INTERVAL '5 minutes';
    
    -- Only create job if no recent pending job exists
    IF existing_job_count = 0 THEN
      INSERT INTO jobs (type, state, payload, tenant_id)
      VALUES (
        'SYNC_TO_WOO',
        'ready',
        jsonb_build_object('productIds', jsonb_build_array(NEW.product_id)),
        product_tenant_id
      );
      
      RAISE NOTICE 'Created SYNC_TO_WOO job for product % with tenant %', NEW.product_id, product_tenant_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Fix trigger to include tenant_id when creating SYNC_TO_WOO jobs for stock
CREATE OR REPLACE FUNCTION public.trigger_sync_stock_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  existing_job_count INTEGER;
  product_id_val UUID;
  product_tenant_id UUID;
BEGIN
  -- Only create job if stock quantity changed
  IF OLD.qty IS DISTINCT FROM NEW.qty THEN
    -- Get product_id and tenant_id from variant
    SELECT v.product_id, p.tenant_id 
    INTO product_id_val, product_tenant_id
    FROM variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.id = NEW.variant_id;
    
    IF product_id_val IS NOT NULL THEN
      -- Check if there's already a pending job for this variant (debouncing)
      SELECT COUNT(*) INTO existing_job_count
      FROM jobs
      WHERE type = 'SYNC_TO_WOO'
        AND state IN ('ready', 'processing')
        AND payload @> jsonb_build_object('variantIds', jsonb_build_array(NEW.variant_id))
        AND created_at > NOW() - INTERVAL '5 minutes';
      
      -- Only create job if no recent pending job exists
      IF existing_job_count = 0 THEN
        INSERT INTO jobs (type, state, payload, tenant_id)
        VALUES (
          'SYNC_TO_WOO',
          'ready',
          jsonb_build_object('variantIds', jsonb_build_array(NEW.variant_id)),
          product_tenant_id
        );
        
        RAISE NOTICE 'Created SYNC_TO_WOO job for variant % with tenant %', NEW.variant_id, product_tenant_id;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;