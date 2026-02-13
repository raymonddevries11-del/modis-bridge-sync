-- Add size_type column to variants table with default 'regular'
ALTER TABLE public.variants 
ADD COLUMN size_type text NOT NULL DEFAULT 'regular';

-- Add a check constraint for valid Google size types
ALTER TABLE public.variants
ADD CONSTRAINT variants_size_type_check 
CHECK (size_type IN ('regular', 'petite', 'plus', 'tall', 'maternity', 'big'));