-- Create enum for AI content status
CREATE TYPE ai_content_status AS ENUM ('pending', 'generated', 'approved', 'rejected');

-- Create table for AI-generated product content
CREATE TABLE public.product_ai_content (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  
  -- AI-generated content fields
  ai_title TEXT,
  ai_short_description TEXT,
  ai_long_description TEXT,
  ai_meta_title TEXT,
  ai_meta_description TEXT,
  ai_keywords TEXT,
  ai_features JSONB DEFAULT '[]'::jsonb,
  ai_suggested_categories JSONB DEFAULT '[]'::jsonb,
  
  -- Status and tracking
  status ai_content_status NOT NULL DEFAULT 'pending',
  generated_at TIMESTAMP WITH TIME ZONE,
  approved_at TIMESTAMP WITH TIME ZONE,
  approved_by TEXT,
  rejected_at TIMESTAMP WITH TIME ZONE,
  rejected_reason TEXT,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Ensure one AI content record per product
  CONSTRAINT unique_product_ai_content UNIQUE (product_id)
);

-- Create index for faster lookups
CREATE INDEX idx_product_ai_content_product_id ON public.product_ai_content(product_id);
CREATE INDEX idx_product_ai_content_tenant_id ON public.product_ai_content(tenant_id);
CREATE INDEX idx_product_ai_content_status ON public.product_ai_content(status);

-- Enable RLS
ALTER TABLE public.product_ai_content ENABLE ROW LEVEL SECURITY;

-- RLS Policies - allow authenticated users to manage AI content
CREATE POLICY "Authenticated users can view AI content"
ON public.product_ai_content
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert AI content"
ON public.product_ai_content
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update AI content"
ON public.product_ai_content
FOR UPDATE
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can delete AI content"
ON public.product_ai_content
FOR DELETE
TO authenticated
USING (true);

-- Add trigger for updated_at
CREATE TRIGGER update_product_ai_content_updated_at
BEFORE UPDATE ON public.product_ai_content
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add comment for documentation
COMMENT ON TABLE public.product_ai_content IS 'Stores AI-generated product content for WooCommerce optimization. Content is generated separately from original product data and can be approved/rejected before export.';