
-- Add retry tracking columns to export_files
ALTER TABLE public.export_files
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN max_retries integer NOT NULL DEFAULT 3,
  ADD COLUMN last_retry_at timestamp with time zone;

COMMENT ON COLUMN public.export_files.retry_count IS 'Number of re-upload attempts after ACK timeout';
COMMENT ON COLUMN public.export_files.max_retries IS 'Max re-uploads before permanent quarantine';
