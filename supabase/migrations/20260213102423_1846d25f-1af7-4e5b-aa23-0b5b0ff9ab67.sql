-- Add product_type column to products
ALTER TABLE public.products 
ADD COLUMN product_type text NOT NULL DEFAULT 'variable' 
CHECK (product_type IN ('simple', 'variable'));