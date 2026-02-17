
CREATE OR REPLACE FUNCTION public.housekeep_jobs()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  stuck_count INTEGER;
  purged_done INTEGER;
  purged_error INTEGER;
BEGIN
  -- 1. Move stuck processing jobs (>15 min) to error
  UPDATE jobs
  SET state = 'error',
      error = 'Housekeeper: stuck in processing beyond 15 min threshold',
      updated_at = now()
  WHERE state = 'processing'
    AND updated_at < now() - interval '15 minutes';
  GET DIAGNOSTICS stuck_count = ROW_COUNT;

  -- 2. Purge completed jobs older than 1 day
  DELETE FROM jobs
  WHERE state = 'done'
    AND updated_at < now() - interval '1 day';
  GET DIAGNOSTICS purged_done = ROW_COUNT;

  -- 3. Purge error jobs older than 7 days
  DELETE FROM jobs
  WHERE state = 'error'
    AND updated_at < now() - interval '7 days';
  GET DIAGNOSTICS purged_error = ROW_COUNT;

  RAISE NOTICE 'Housekeeper: % stuck reset, % done purged, % error purged', stuck_count, purged_done, purged_error;
END;
$function$;
