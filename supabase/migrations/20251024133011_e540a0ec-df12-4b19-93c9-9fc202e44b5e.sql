-- Drop the incorrect policy
DROP POLICY IF EXISTS "Service role can manage order exports" ON storage.objects;

-- Create correct policy for service role
CREATE POLICY "Allow service role full access to order exports"
ON storage.objects FOR ALL
TO service_role
USING (bucket_id = 'order-exports')
WITH CHECK (bucket_id = 'order-exports');

-- Also allow authenticated users to read (for the UI)
CREATE POLICY "Allow authenticated users to read order exports"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'order-exports');