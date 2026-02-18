
-- Add reconciled_at and reconciliation_hash columns to export_files
ALTER TABLE public.export_files
  ADD COLUMN IF NOT EXISTS reconciled_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS reconciliation_hash text,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;

-- Add index for reconciliation queries
CREATE INDEX IF NOT EXISTS idx_export_files_ack_status ON public.export_files (ack_status);
