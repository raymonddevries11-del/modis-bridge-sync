-- Drop the service role policy that uses auth.role()
DROP POLICY IF EXISTS "Service role can manage product images" ON storage.objects;

-- Create a policy that allows uploads with service role key
-- This works by checking if the request is authenticated (any auth token)
-- and the bucket is correct. The service role key bypasses RLS anyway.
CREATE POLICY "Allow service role uploads"
ON storage.objects
FOR INSERT
TO authenticated, service_role
WITH CHECK (bucket_id = 'product-images');

-- Also allow the service role to check existence
CREATE POLICY "Allow service role reads"
ON storage.objects
FOR SELECT
TO authenticated, service_role
USING (bucket_id = 'product-images');