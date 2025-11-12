-- Trigger function for product attribute changes
CREATE OR REPLACE FUNCTION public.trigger_sync_product_attributes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  change_detected BOOLEAN := false;
  change_reason TEXT := 'attributes';
BEGIN
  -- Check if images, categories, or attributes changed
  IF (OLD.images IS DISTINCT FROM NEW.images) THEN
    change_detected := true;
    change_reason := 'images';
  ELSIF (OLD.categories IS DISTINCT FROM NEW.categories) THEN
    change_detected := true;
    change_reason := 'categories';
  ELSIF (OLD.attributes IS DISTINCT FROM NEW.attributes) THEN
    change_detected := true;
    change_reason := 'attributes';
  END IF;

  -- Only create pending sync if changes detected
  IF change_detected THEN
    -- Insert into pending_product_syncs with debouncing (ON CONFLICT UPDATE)
    INSERT INTO pending_product_syncs (product_id, tenant_id, reason, created_at)
    VALUES (NEW.id, NEW.tenant_id, change_reason, now())
    ON CONFLICT (product_id, reason) 
    DO UPDATE SET created_at = now();
    
    RAISE NOTICE 'Created pending sync for product % (reason: %)', NEW.id, change_reason;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on products table for attribute changes
DROP TRIGGER IF EXISTS trigger_product_attributes_sync ON products;
CREATE TRIGGER trigger_product_attributes_sync
  AFTER UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_product_attributes();