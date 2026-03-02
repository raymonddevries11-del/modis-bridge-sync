
-- Remove duplicate triggers (keep the trg_* prefixed ones, drop the newer duplicates)
DROP TRIGGER IF EXISTS trigger_sync_prices ON public.product_prices;
DROP TRIGGER IF EXISTS trigger_sync_attributes ON public.products;
DROP TRIGGER IF EXISTS trigger_sync_stock ON public.stock_totals;
