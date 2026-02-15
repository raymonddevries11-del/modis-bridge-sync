
-- Add ack_status to export_files for tracking the full lifecycle
ALTER TABLE public.export_files 
  ADD COLUMN ack_status text NOT NULL DEFAULT 'pending';

-- pending = XML generated, not yet on SFTP
-- uploaded = on SFTP in /ready/, awaiting Modis pickup
-- acked = file disappeared from /ready/ (Modis picked it up)
-- timeout = file still on SFTP after X hours

COMMENT ON COLUMN public.export_files.ack_status IS 'Lifecycle: pending → uploaded → acked | timeout';

-- Add uploaded_to_sftp_at for timing ACK checks
ALTER TABLE public.export_files
  ADD COLUMN uploaded_to_sftp_at timestamp with time zone;
