-- Enable required extensions for scheduled jobs
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

-- Schedule job-scheduler to run every 2 minutes
SELECT cron.schedule(
  'job-queue-processor',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/job-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Schedule sftp-watcher to run every 2 minutes
SELECT cron.schedule(
  'sftp-file-watcher',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://dnllaaspkqqfuuxkvoma.supabase.co/functions/v1/sftp-watcher',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRubGxhYXNwa3FxZnV1eGt2b21hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNzk2MDEsImV4cCI6MjA3Njg1NTYwMX0.Y2AvbL2qgbZ-e9XA00YrKVAUDcSz40XkNoXOd6UCyfo'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);