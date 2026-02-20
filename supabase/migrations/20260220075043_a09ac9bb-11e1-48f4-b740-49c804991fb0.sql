-- Trigger function: on PRICE_STOCK insert into pending_product_syncs,
-- fire pg_net to call drain-pending-syncs immediately (debounced by the 15s window in the function itself)
CREATE OR REPLACE FUNCTION public.notify_drain_price_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _supabase_url TEXT;
  _anon_key TEXT;
BEGIN
  -- Only fire for high-priority PRICE_STOCK scope
  IF NEW.sync_scope = 'PRICE_STOCK' AND NEW.status = 'PENDING' THEN
    SELECT value->>'url' INTO _supabase_url FROM config WHERE key = 'supabase_internal';
    SELECT value->>'anon_key' INTO _anon_key FROM config WHERE key = 'supabase_internal';
    
    -- Fallback to env if config not set
    IF _supabase_url IS NULL THEN
      _supabase_url := 'https://dnllaaspkqqfuuxkvoma.supabase.co';
    END IF;
    IF _anon_key IS NULL THEN
      _anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo';
    END IF;

    PERFORM net.http_post(
      url := _supabase_url || '/functions/v1/drain-pending-syncs',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || _anon_key
      ),
      body := '{"scope": "PRICE_STOCK"}'::jsonb
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Attach trigger (fires once per statement to avoid flooding)
CREATE TRIGGER trg_drain_price_stock
AFTER INSERT ON pending_product_syncs
FOR EACH ROW
EXECUTE FUNCTION notify_drain_price_stock();