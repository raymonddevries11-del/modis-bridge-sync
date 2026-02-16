
-- Cache WooCommerce global attributes and map them to PIM attribute names
CREATE TABLE public.woo_global_attributes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  woo_attr_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  pim_attribute_name TEXT,  -- mapped PIM attribute key (e.g. "Wijdte", "Uitneembaar voetbed")
  terms JSONB NOT NULL DEFAULT '[]'::jsonb,  -- cached terms: [{id, name, slug, count}]
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, woo_attr_id)
);

-- Enable RLS
ALTER TABLE public.woo_global_attributes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage woo global attributes"
  ON public.woo_global_attributes FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read woo global attributes"
  ON public.woo_global_attributes FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage woo global attributes"
  ON public.woo_global_attributes FOR ALL
  USING (true)
  WITH CHECK (true);

-- Index for fast lookups during push
CREATE INDEX idx_woo_global_attrs_tenant ON public.woo_global_attributes(tenant_id);
CREATE INDEX idx_woo_global_attrs_slug ON public.woo_global_attributes(tenant_id, slug);
