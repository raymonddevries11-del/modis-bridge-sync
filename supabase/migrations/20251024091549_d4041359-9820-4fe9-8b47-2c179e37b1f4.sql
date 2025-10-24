-- Modis Bridge Database Schema

-- Create enums
CREATE TYPE public.job_state AS ENUM ('ready', 'processing', 'done', 'error');

-- Brands table
CREATE TABLE public.brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Suppliers table
CREATE TABLE public.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Products table
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  tax_code TEXT,
  brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL,
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  images JSONB DEFAULT '[]'::jsonb,
  color JSONB,
  url_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Product prices table
CREATE TABLE public.product_prices (
  product_id UUID PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  regular NUMERIC(10,2),
  list NUMERIC(10,2),
  currency TEXT DEFAULT 'EUR',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Variants table
CREATE TABLE public.variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  maat_id TEXT NOT NULL,
  size_label TEXT NOT NULL,
  ean TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(product_id, maat_id)
);

-- Stock total table
CREATE TABLE public.stock_totals (
  variant_id UUID PRIMARY KEY REFERENCES public.variants(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stock by store table
CREATE TABLE public.stock_by_store (
  variant_id UUID NOT NULL REFERENCES public.variants(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, store_id)
);

-- Orders table
CREATE TABLE public.orders (
  order_number TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  currency TEXT DEFAULT 'EUR',
  totals JSONB NOT NULL,
  customer JSONB NOT NULL,
  billing JSONB NOT NULL,
  shipping JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);

-- Order lines table
CREATE TABLE public.order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT NOT NULL REFERENCES public.orders(order_number) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  ean TEXT,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  vat_rate NUMERIC(5,2) NOT NULL,
  attributes JSONB DEFAULT '{}'::jsonb
);

-- Jobs table for queue system
CREATE TABLE public.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  state public.job_state NOT NULL DEFAULT 'ready',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys table
CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- Config table for SFTP/WooCommerce settings
CREATE TABLE public.config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for better performance
CREATE INDEX idx_products_sku ON public.products(sku);
CREATE INDEX idx_products_brand ON public.products(brand_id);
CREATE INDEX idx_products_supplier ON public.products(supplier_id);
CREATE INDEX idx_variants_product ON public.variants(product_id);
CREATE INDEX idx_variants_ean ON public.variants(ean);
CREATE INDEX idx_order_lines_order ON public.order_lines(order_number);
CREATE INDEX idx_order_lines_sku ON public.order_lines(sku);
CREATE INDEX idx_jobs_state ON public.jobs(state);
CREATE INDEX idx_jobs_type ON public.jobs(type);

-- Enable Row Level Security
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_by_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.config ENABLE ROW LEVEL SECURITY;

-- Create policies (public access for now - can be restricted later with API key auth)
CREATE POLICY "Allow all operations on brands" ON public.brands FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on suppliers" ON public.suppliers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on products" ON public.products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on product_prices" ON public.product_prices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on variants" ON public.variants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on stock_totals" ON public.stock_totals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on stock_by_store" ON public.stock_by_store FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on orders" ON public.orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on order_lines" ON public.order_lines FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on jobs" ON public.jobs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on api_keys" ON public.api_keys FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on config" ON public.config FOR ALL USING (true) WITH CHECK (true);

-- Create function to update timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for automatic timestamp updates
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_variants_updated_at BEFORE UPDATE ON public.variants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();