-- Create changelog table for tracking tenant activities
CREATE TABLE public.changelog (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.changelog ENABLE ROW LEVEL SECURITY;

-- Create RLS policy
CREATE POLICY "Allow all operations on changelog" 
ON public.changelog 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create index for faster queries
CREATE INDEX idx_changelog_tenant_created ON public.changelog(tenant_id, created_at DESC);
CREATE INDEX idx_changelog_event_type ON public.changelog(event_type);

-- Add comment
COMMENT ON TABLE public.changelog IS 'Audit log tracking all significant events per tenant';