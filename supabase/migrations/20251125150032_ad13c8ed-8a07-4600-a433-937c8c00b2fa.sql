
-- Disable alle triggers die automatisch WooCommerce sync jobs aanmaken
-- Deze worden alleen nog aangeroepen vanuit XML import processen

-- Drop trigger voor price changes
DROP TRIGGER IF EXISTS sync_product_prices ON product_prices;

-- Drop trigger voor stock changes  
DROP TRIGGER IF EXISTS sync_stock_totals ON stock_totals;

-- Drop trigger voor product attribute changes
DROP TRIGGER IF EXISTS sync_product_attributes ON products;

-- We houden de track_product_change triggers aan voor pending_product_syncs
-- maar verwijderen de create_batch_sync_jobs functie die deze omzet in jobs
DROP FUNCTION IF EXISTS create_batch_sync_jobs() CASCADE;

-- Maak een nieuwe versie die NIETS doet (placeholder)
CREATE OR REPLACE FUNCTION create_batch_sync_jobs()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Functie is uitgeschakeld - jobs worden alleen nog aangemaakt door XML import
  RAISE NOTICE 'Batch sync job creation is disabled. Jobs are only created by XML import processes.';
  RETURN;
END;
$$;
