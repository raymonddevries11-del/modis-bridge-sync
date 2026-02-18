CREATE INDEX IF NOT EXISTS idx_woo_products_sku ON public.woo_products (sku);
CREATE INDEX IF NOT EXISTS idx_woo_products_updated_at ON public.woo_products (updated_at DESC);