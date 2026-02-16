
-- Create woo_category_mappings table
CREATE TABLE public.woo_category_mappings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  source_category text NOT NULL,
  woo_category text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_category)
);

-- Enable RLS
ALTER TABLE public.woo_category_mappings ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Admins can manage woo category mappings"
ON public.woo_category_mappings
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read woo category mappings"
ON public.woo_category_mappings
FOR SELECT
USING (true);

CREATE POLICY "Service role can manage woo category mappings"
ON public.woo_category_mappings
FOR ALL
USING (true)
WITH CHECK (true);

-- Trigger for updated_at
CREATE TRIGGER update_woo_category_mappings_updated_at
BEFORE UPDATE ON public.woo_category_mappings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
