
-- Fix cron jobs with correct Supabase URL
SELECT cron.unschedule('process-job-queue');
SELECT cron.unschedule('sync-new-products-hourly');
SELECT cron.unschedule('daily-full-product-sync');

-- Re-create with correct URL using net.http_post
SELECT cron.schedule(
  'process-job-queue',
  '* * * * *',
  $$SELECT net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/job-scheduler'::text,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo"}'::jsonb,
    body := '{}'::jsonb
  );$$
);

SELECT cron.schedule(
  'sync-new-products-hourly',
  '15 * * * *',
  $$SELECT net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/sync-new-products'::text,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo"}'::jsonb,
    body := '{}'::jsonb
  );$$
);

SELECT cron.schedule(
  'daily-full-product-sync',
  '0 3 * * *',
  $$SELECT net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/daily-bulk-sync'::text,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo"}'::jsonb,
    body := '{}'::jsonb
  );$$
);
