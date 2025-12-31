-- Allow service role to delete jobs
CREATE POLICY "Service role can delete jobs"
ON public.jobs
FOR DELETE
USING (true);

-- Also add delete capability for authenticated users (existing policy only covers SELECT)
DROP POLICY IF EXISTS "Authenticated can delete jobs" ON public.jobs;

CREATE POLICY "Anyone can delete jobs"
ON public.jobs
FOR DELETE
USING (true);