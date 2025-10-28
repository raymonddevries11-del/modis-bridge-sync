-- Drop the trigger on orders table (it doesn't have updated_at column)
DROP TRIGGER IF EXISTS update_orders_updated_at ON public.orders;

-- Create tenants table
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on tenants
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- Create policy for tenants (allow all for now)
CREATE POLICY "Allow all operations on tenants" ON public.tenants
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create tenant_config table
CREATE TABLE public.tenant_config (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  woocommerce_url TEXT NOT NULL,
  woocommerce_consumer_key TEXT NOT NULL,
  woocommerce_consumer_secret TEXT NOT NULL,
  sftp_inbound_path TEXT NOT NULL,
  sftp_outbound_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on tenant_config
ALTER TABLE public.tenant_config ENABLE ROW LEVEL SECURITY;

-- Create policy for tenant_config
CREATE POLICY "Allow all operations on tenant_config" ON public.tenant_config
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add tenant_id to existing tables
ALTER TABLE public.products ADD COLUMN tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.orders ADD COLUMN tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.order_lines ADD COLUMN tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.export_files ADD COLUMN tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.jobs ADD COLUMN tenant_id UUID REFERENCES public.tenants(id);

-- Create indexes for better query performance
CREATE INDEX idx_products_tenant_id ON public.products(tenant_id);
CREATE INDEX idx_orders_tenant_id ON public.orders(tenant_id);
CREATE INDEX idx_order_lines_tenant_id ON public.order_lines(tenant_id);
CREATE INDEX idx_export_files_tenant_id ON public.export_files(tenant_id);
CREATE INDEX idx_jobs_tenant_id ON public.jobs(tenant_id);

-- Insert default tenant (Koster Schoenmode)
INSERT INTO public.tenants (name, slug, active)
VALUES ('Koster Schoenmode', 'kosterschoenmode', true);

-- Migrate existing data to Koster Schoenmode tenant
UPDATE public.products SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'kosterschoenmode') WHERE tenant_id IS NULL;
UPDATE public.orders SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'kosterschoenmode') WHERE tenant_id IS NULL;
UPDATE public.order_lines SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'kosterschoenmode') WHERE tenant_id IS NULL;
UPDATE public.export_files SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'kosterschoenmode') WHERE tenant_id IS NULL;
UPDATE public.jobs SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'kosterschoenmode') WHERE tenant_id IS NULL;

-- Insert default WooCommerce config for Koster Schoenmode
INSERT INTO public.tenant_config (tenant_id, woocommerce_url, woocommerce_consumer_key, woocommerce_consumer_secret, sftp_inbound_path, sftp_outbound_path)
SELECT 
  id,
  COALESCE((SELECT value->>'woocommerce_url' FROM public.config WHERE key = 'woocommerce'), 'https://kosterschoenmode.nl'),
  COALESCE((SELECT value->>'consumer_key' FROM public.config WHERE key = 'woocommerce'), ''),
  COALESCE((SELECT value->>'consumer_secret' FROM public.config WHERE key = 'woocommerce'), ''),
  '/home/customer/www/developmentplatform.nl/public_html/kosterschoenmode/modis-to-wp',
  '/home/customer/www/developmentplatform.nl/public_html/kosterschoenmode/wp-to-modis'
FROM public.tenants WHERE slug = 'kosterschoenmode';

-- Add trigger for updated_at on tenants
CREATE TRIGGER update_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add trigger for updated_at on tenant_config
CREATE TRIGGER update_tenant_config_updated_at
  BEFORE UPDATE ON public.tenant_config
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();