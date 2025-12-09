-- Allow public read access to export_files for GitHub Actions sync
CREATE POLICY "Public can read unsynced export files"
ON public.export_files
FOR SELECT
USING (synced_to_sftp = false);