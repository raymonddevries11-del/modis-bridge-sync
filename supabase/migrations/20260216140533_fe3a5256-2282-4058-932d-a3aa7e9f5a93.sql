
-- Move nightly-woo-revalidation from 03:00 to 04:00 to avoid overlap with daily-full-product-sync
SELECT cron.unschedule('nightly-woo-revalidation');

SELECT cron.schedule(
  'nightly-woo-revalidation',
  '0 4 * * *',
  $$SELECT net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/validate-woo-urls'::text,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo"}'::jsonb,
    body := '{"tenantId": "f0dd152c-a807-4e04-b0a0-769e9229046b", "dryRun": false, "localOffset": 0, "localLimit": 500}'::jsonb
  );$$
);
