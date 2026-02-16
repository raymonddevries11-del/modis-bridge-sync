
-- Table to store WooCommerce-specific product data
CREATE TABLE public.woo_products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  woo_id INTEGER NOT NULL,
  sku TEXT,
  name TEXT NOT NULL,
  slug TEXT,
  permalink TEXT,
  status TEXT DEFAULT 'publish',
  stock_status TEXT DEFAULT 'instock',
  stock_quantity INTEGER,
  regular_price TEXT,
  sale_price TEXT,
  categories JSONB DEFAULT '[]'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  images JSONB DEFAULT '[]'::jsonb,
  type TEXT DEFAULT 'simple',
  last_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  last_pushed_at TIMESTAMP WITH TIME ZONE,
  last_push_changes JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, woo_id)
);

-- Enable RLS
ALTER TABLE public.woo_products ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Authenticated can read woo products"
ON public.woo_products FOR SELECT
USING (true);

CREATE POLICY "Admins can manage woo products"
ON public.woo_products FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role can manage woo products"
ON public.woo_products FOR ALL
USING (true)
WITH CHECK (true);

-- Index for quick lookups
CREATE INDEX idx_woo_products_sku ON public.woo_products(sku);
CREATE INDEX idx_woo_products_tenant ON public.woo_products(tenant_id);
CREATE INDEX idx_woo_products_product_id ON public.woo_products(product_id);

-- Trigger for updated_at
CREATE TRIGGER update_woo_products_updated_at
BEFORE UPDATE ON public.woo_products
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
