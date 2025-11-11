-- Create a cron job that runs every minute to process pending SYNC_TO_WOO jobs
-- This ensures near-realtime synchronization to WooCommerce
SELECT cron.schedule(
  'process-woocommerce-sync-jobs',
  '* * * * *', -- Every minute
  $$
  SELECT
    net.http_post(
      url:='https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/job-scheduler',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
  $$
);

-- Log the cron job creation
INSERT INTO changelog (event_type, description, tenant_id, metadata)
SELECT 
  'SYSTEM_CONFIG',
  'Realtime WooCommerce sync enabled - job scheduler runs every minute',
  id,
  '{"cron_schedule": "* * * * *", "job_type": "SYNC_TO_WOO"}'::jsonb
FROM tenants
LIMIT 1;