
-- Drop orphaned track_product_change function (not attached to any trigger)
-- Its logic is fully covered by trigger_sync_product_prices() and trigger_sync_stock_totals()
DROP FUNCTION IF EXISTS public.track_product_change();
