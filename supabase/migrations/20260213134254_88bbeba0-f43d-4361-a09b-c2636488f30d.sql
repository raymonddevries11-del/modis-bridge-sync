-- Add field_sources column to track origin of each field value
ALTER TABLE public.products 
ADD COLUMN field_sources jsonb NOT NULL DEFAULT '{}'::jsonb;