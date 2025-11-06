-- Allow authenticated users to delete jobs
CREATE POLICY "Authenticated can delete jobs"
ON jobs
FOR DELETE
TO authenticated
USING (true);