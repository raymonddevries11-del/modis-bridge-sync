
-- Add retry tracking columns to image_sync_status
ALTER TABLE public.image_sync_status
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone DEFAULT NULL;

-- Index for efficient retry queries
CREATE INDEX IF NOT EXISTS idx_image_sync_failed_retry
  ON public.image_sync_status (status, next_retry_at)
  WHERE status = 'failed';
