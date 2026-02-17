
-- Track image upload status per product
CREATE TABLE public.image_sync_status (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending, uploaded, confirmed, failed
  image_count INTEGER NOT NULL DEFAULT 0,
  uploaded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  woo_media_ids JSONB DEFAULT '[]'::jsonb,
  error_message TEXT,
  push_attempted_at TIMESTAMP WITH TIME ZONE,
  push_confirmed_at TIMESTAMP WITH TIME ZONE,
  webhook_confirmed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(product_id)
);

-- Enable RLS
ALTER TABLE public.image_sync_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read image sync status"
ON public.image_sync_status FOR SELECT USING (true);

CREATE POLICY "Service role can manage image sync status"
ON public.image_sync_status FOR ALL WITH CHECK (true);

CREATE POLICY "Admins can manage image sync status"
ON public.image_sync_status FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Trigger for updated_at
CREATE TRIGGER update_image_sync_status_updated_at
BEFORE UPDATE ON public.image_sync_status
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Index for dashboard queries
CREATE INDEX idx_image_sync_status_tenant_status ON public.image_sync_status(tenant_id, status);
