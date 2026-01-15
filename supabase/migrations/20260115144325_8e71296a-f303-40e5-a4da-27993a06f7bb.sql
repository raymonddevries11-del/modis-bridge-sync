-- Add tags column to products table (array of text for flexible tagging)
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Create index for efficient tag filtering
CREATE INDEX IF NOT EXISTS idx_products_tags ON public.products USING GIN(tags);