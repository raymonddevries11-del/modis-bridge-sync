-- Add attributes column to products table to store additional product metadata
ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes jsonb DEFAULT '{}'::jsonb;

-- Add comment for documentation
COMMENT ON COLUMN products.attributes IS 'Additional product attributes like gender, materials, type, heel height, closure, etc.';