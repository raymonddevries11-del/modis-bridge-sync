-- Add locked_fields column to products table
ALTER TABLE public.products 
ADD COLUMN locked_fields text[] NOT NULL DEFAULT '{}'::text[];