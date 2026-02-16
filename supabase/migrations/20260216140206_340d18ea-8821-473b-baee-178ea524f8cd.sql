
-- Remove duplicate old cron jobs that overlap with new ones
SELECT cron.unschedule('job-scheduler-every-minute');
SELECT cron.unschedule('batch-woo-sync-every-minute');
