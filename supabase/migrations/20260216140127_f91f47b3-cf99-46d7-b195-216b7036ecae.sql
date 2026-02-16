
-- 1. Attach trigger for stock changes → create SYNC_TO_WOO jobs
CREATE TRIGGER trg_stock_totals_sync
AFTER UPDATE ON public.stock_totals
FOR EACH ROW
EXECUTE FUNCTION public.trigger_sync_stock_totals();

-- 2. Attach trigger for price changes → create SYNC_TO_WOO jobs
CREATE TRIGGER trg_product_prices_sync
AFTER UPDATE ON public.product_prices
FOR EACH ROW
EXECUTE FUNCTION public.trigger_sync_product_prices();

-- 3. Cron: run job-scheduler every minute to process pending jobs
SELECT cron.schedule(
  'process-job-queue',
  '* * * * *',
  $$SELECT extensions.http_post(
    'SUPABASE_URL_PLACEHOLDER/functions/v1/job-scheduler',
    '{}',
    'application/json'
  );$$
);

-- 4. Cron: run sync-new-products every hour at :15
SELECT cron.schedule(
  'sync-new-products-hourly',
  '15 * * * *',
  $$SELECT extensions.http_post(
    'SUPABASE_URL_PLACEHOLDER/functions/v1/sync-new-products',
    '{}',
    'application/json'
  );$$
);

-- 5. Cron: run daily-bulk-sync at 03:00 UTC
SELECT cron.schedule(
  'daily-full-product-sync',
  '0 3 * * *',
  $$SELECT extensions.http_post(
    'SUPABASE_URL_PLACEHOLDER/functions/v1/daily-bulk-sync',
    '{}',
    'application/json'
  );$$
);
