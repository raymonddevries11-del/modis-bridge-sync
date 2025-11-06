-- Drop the existing restrictive policies
DROP POLICY IF EXISTS "Allow service role uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow service role reads" ON storage.objects;

-- Create more permissive policies that don't require service role authentication
-- Allow uploads to product-images bucket without authentication (for GitHub Actions)
CREATE POLICY "Allow uploads to product-images"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'product-images');

-- Allow public reads from product-images bucket
CREATE POLICY "Allow public reads from product-images"
ON storage.objects
FOR SELECT
USING (bucket_id = 'product-images');

-- Allow listing product-images bucket
CREATE POLICY "Allow list product-images"
ON storage.objects
FOR SELECT
USING (bucket_id = 'product-images');