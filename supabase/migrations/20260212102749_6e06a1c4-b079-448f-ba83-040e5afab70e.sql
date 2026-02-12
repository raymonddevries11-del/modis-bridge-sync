
-- Table to map article groups to Google product categories
CREATE TABLE public.google_category_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  article_group_id TEXT NOT NULL,
  article_group_description TEXT,
  google_category TEXT NOT NULL,
  gender TEXT DEFAULT 'unisex',
  age_group TEXT DEFAULT 'adult',
  condition TEXT DEFAULT 'new',
  material TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, article_group_id)
);

-- Enable RLS
ALTER TABLE public.google_category_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage google category mappings"
  ON public.google_category_mappings FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read google category mappings"
  ON public.google_category_mappings FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage google category mappings"
  ON public.google_category_mappings FOR ALL
  USING (true)
  WITH CHECK (true);

-- Trigger for updated_at
CREATE TRIGGER update_google_category_mappings_updated_at
  BEFORE UPDATE ON public.google_category_mappings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Table for feed configuration per tenant
CREATE TABLE public.google_feed_config (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) PRIMARY KEY,
  shop_url TEXT NOT NULL DEFAULT '',
  feed_title TEXT DEFAULT 'Google Shopping Feed',
  feed_description TEXT DEFAULT '',
  currency TEXT DEFAULT 'EUR',
  shipping_country TEXT DEFAULT 'NL',
  shipping_price NUMERIC DEFAULT 0,
  enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.google_feed_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage google feed config"
  ON public.google_feed_config FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read google feed config"
  ON public.google_feed_config FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage google feed config"
  ON public.google_feed_config FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER update_google_feed_config_updated_at
  BEFORE UPDATE ON public.google_feed_config
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
