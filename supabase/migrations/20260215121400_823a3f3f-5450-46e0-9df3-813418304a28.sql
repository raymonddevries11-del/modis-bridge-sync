
-- Validation log table for inbound XML files
CREATE TABLE public.xml_validation_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL, -- 'stock', 'stock-full', 'article', 'unknown'
  file_size INTEGER,
  is_valid BOOLEAN NOT NULL DEFAULT false,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. { items: 500, fields: [...] }
  validated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for fast lookups by tenant and recency
CREATE INDEX idx_xml_validation_logs_tenant ON public.xml_validation_logs(tenant_id, validated_at DESC);

-- Enable RLS
ALTER TABLE public.xml_validation_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read xml validation logs"
  ON public.xml_validation_logs FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage xml validation logs"
  ON public.xml_validation_logs FOR ALL
  WITH CHECK (true);
