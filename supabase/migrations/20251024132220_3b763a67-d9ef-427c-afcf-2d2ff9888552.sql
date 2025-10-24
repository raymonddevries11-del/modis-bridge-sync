-- Create storage bucket for order XML files
INSERT INTO storage.buckets (id, name, public) 
VALUES ('order-exports', 'order-exports', false)
ON CONFLICT (id) DO NOTHING;

-- Allow service role to manage files
CREATE POLICY "Service role can manage order exports"
ON storage.objects FOR ALL
USING (bucket_id = 'order-exports' AND auth.role() = 'service_role')
WITH CHECK (bucket_id = 'order-exports' AND auth.role() = 'service_role');