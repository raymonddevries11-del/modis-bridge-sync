
-- Add fetch_diff column to track what changed since last fetch
ALTER TABLE public.woo_products
ADD COLUMN IF NOT EXISTS fetch_diff JSONB DEFAULT NULL,
ADD COLUMN IF NOT EXISTS previous_data JSONB DEFAULT NULL;

-- Change log table for WooCommerce product changes
CREATE TABLE public.woo_product_changes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  woo_product_id UUID NOT NULL REFERENCES public.woo_products(id) ON DELETE CASCADE,
  woo_id INTEGER NOT NULL,
  sku TEXT,
  product_name TEXT,
  change_type TEXT NOT NULL, -- 'price_change', 'stock_change', 'status_change', 'content_change', 'image_change', 'new_product', 'removed_product'
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.woo_product_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read woo product changes"
ON public.woo_product_changes FOR SELECT USING (true);

CREATE POLICY "Service role can manage woo product changes"
ON public.woo_product_changes FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_woo_product_changes_tenant ON public.woo_product_changes(tenant_id);
CREATE INDEX idx_woo_product_changes_detected ON public.woo_product_changes(detected_at DESC);
CREATE INDEX idx_woo_product_changes_type ON public.woo_product_changes(change_type);
