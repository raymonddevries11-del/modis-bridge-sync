-- Add missing columns to products
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS short_description text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'concept';

-- Update trigger to include short_description in CONTENT scope detection
CREATE OR REPLACE FUNCTION public.trigger_sync_product_attributes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_scope TEXT;
  v_priority INT;
BEGIN
  -- Determine scope based on what changed
  IF (OLD.images IS DISTINCT FROM NEW.images) THEN
    v_scope := 'MEDIA';
    v_priority := 40;
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
        (OLD.short_description IS DISTINCT FROM NEW.short_description) OR
        (OLD.meta_title IS DISTINCT FROM NEW.meta_title) OR
        (OLD.meta_description IS DISTINCT FROM NEW.meta_description) OR
        (OLD.focus_keyword IS DISTINCT FROM NEW.focus_keyword) THEN
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