
-- ============================================================
-- TRIGGER AUDIT & CLEANUP
-- ============================================================
-- PROBLEM: Duplicate triggers on product_prices and stock_totals
-- cause double-writes to pending_product_syncs.
--
-- product_prices has:
--   1. queue_price_sync_trigger  → queue_price_sync()       [OLD - only writes pending_product_syncs]
--   2. trg_product_prices_sync   → trigger_sync_product_prices() [NEW - jobs + fallback to pending]
--
-- stock_totals has:
--   1. queue_stock_sync_trigger  → queue_stock_sync()       [OLD - only writes pending_product_syncs]
--   2. trg_stock_totals_sync     → trigger_sync_stock_totals()  [NEW - jobs + fallback to pending]
--
-- The OLD triggers are redundant because the NEW triggers already
-- handle the pending_product_syncs fallback when backpressure kicks in.
-- ============================================================

-- 1. Drop redundant old triggers
DROP TRIGGER IF EXISTS queue_price_sync_trigger ON public.product_prices;
DROP TRIGGER IF EXISTS queue_stock_sync_trigger ON public.stock_totals;

-- 2. Drop orphaned old functions (no longer referenced)
DROP FUNCTION IF EXISTS public.queue_price_sync();
DROP FUNCTION IF EXISTS public.queue_stock_sync();

-- 3. Also wire up the existing trigger_sync_product_attributes function
--    which exists but has NO trigger attached.
CREATE TRIGGER trg_product_attributes_sync
  AFTER UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_product_attributes();
