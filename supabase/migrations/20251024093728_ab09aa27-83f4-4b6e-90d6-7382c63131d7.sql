-- Create trigger function for product_prices sync
CREATE OR REPLACE FUNCTION trigger_sync_product_prices()
RETURNS TRIGGER AS $$
DECLARE
  existing_job_count INTEGER;
BEGIN
  -- Only create job if price actually changed
  IF (OLD.regular IS DISTINCT FROM NEW.regular) OR (OLD.list IS DISTINCT FROM NEW.list) THEN
    -- Check if there's already a pending job for this product (debouncing)
    SELECT COUNT(*) INTO existing_job_count
    FROM jobs
    WHERE type = 'SYNC_TO_WOO'
      AND state IN ('ready', 'processing')
      AND payload @> jsonb_build_object('productIds', jsonb_build_array(NEW.product_id))
      AND created_at > NOW() - INTERVAL '5 minutes';
    
    -- Only create job if no recent pending job exists
    IF existing_job_count = 0 THEN
      INSERT INTO jobs (type, state, payload)
      VALUES (
        'SYNC_TO_WOO',
        'ready',
        jsonb_build_object('productIds', jsonb_build_array(NEW.product_id))
      );
      
      RAISE NOTICE 'Created SYNC_TO_WOO job for product %', NEW.product_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger function for stock_totals sync
CREATE OR REPLACE FUNCTION trigger_sync_stock_totals()
RETURNS TRIGGER AS $$
DECLARE
  existing_job_count INTEGER;
  product_id_val UUID;
BEGIN
  -- Only create job if stock quantity changed
  IF OLD.qty IS DISTINCT FROM NEW.qty THEN
    -- Get product_id from variant
    SELECT v.product_id INTO product_id_val
    FROM variants v
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
        INSERT INTO jobs (type, state, payload)
        VALUES (
          'SYNC_TO_WOO',
          'ready',
          jsonb_build_object('variantIds', jsonb_build_array(NEW.variant_id))
        );
        
        RAISE NOTICE 'Created SYNC_TO_WOO job for variant %', NEW.variant_id;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
DROP TRIGGER IF EXISTS sync_product_prices_trigger ON product_prices;
CREATE TRIGGER sync_product_prices_trigger
  AFTER UPDATE ON product_prices
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_product_prices();

DROP TRIGGER IF EXISTS sync_stock_totals_trigger ON stock_totals;
CREATE TRIGGER sync_stock_totals_trigger
  AFTER UPDATE ON stock_totals
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_stock_totals();
