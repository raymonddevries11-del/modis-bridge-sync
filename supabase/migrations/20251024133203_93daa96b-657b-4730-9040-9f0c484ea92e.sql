-- Remove all RLS policies from storage.objects for order-exports bucket
DROP POLICY IF EXISTS "Allow service role full access to order exports" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to read order exports" ON storage.objects;

-- Service role bypasses RLS by default, so no policies needed
-- Just ensure the bucket exists and is configured correctly