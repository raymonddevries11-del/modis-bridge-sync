
-- Daily housekeeper: clean up stuck processing jobs and purge old completed/error jobs
CREATE OR REPLACE FUNCTION public.housekeep_jobs()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  stuck_count INTEGER;
  purged_count INTEGER;
BEGIN
  -- 1. Move stuck processing jobs (>15 min) to error
  UPDATE jobs
  SET state = 'error',
      error = 'Housekeeper: stuck in processing beyond 15 min threshold',
      updated_at = now()
  WHERE state = 'processing'
    AND updated_at < now() - interval '15 minutes';
  GET DIAGNOSTICS stuck_count = ROW_COUNT;

  -- 2. Purge completed jobs older than 7 days
  DELETE FROM jobs
  WHERE state = 'done'
    AND updated_at < now() - interval '7 days';
  GET DIAGNOSTICS purged_count = ROW_COUNT;

  -- 3. Purge error jobs older than 30 days
  DELETE FROM jobs
  WHERE state = 'error'
    AND updated_at < now() - interval '30 days';

  RAISE NOTICE 'Housekeeper: % stuck jobs cleaned, % old done jobs purged', stuck_count, purged_count;
END;
$$;

-- Schedule daily at 02:00 UTC (before the nightly sync at 03:00)
SELECT cron.schedule(
  'daily-job-housekeeper',
  '0 2 * * *',
  $$SELECT public.housekeep_jobs();$$
);
