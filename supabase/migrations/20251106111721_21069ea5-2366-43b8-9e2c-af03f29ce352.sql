-- Add service role policy for product image uploads (needed for edge functions)
CREATE POLICY "Service role can manage product images"
ON storage.objects FOR ALL
USING (bucket_id = 'product-images' AND auth.role() = 'service_role')
WITH CHECK (bucket_id = 'product-images' AND auth.role() = 'service_role');