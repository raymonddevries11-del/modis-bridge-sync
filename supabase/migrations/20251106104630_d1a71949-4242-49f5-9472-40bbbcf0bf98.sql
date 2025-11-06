-- Add extra product fields from XML import
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_percentage numeric DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_description text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS webshop_text text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS webshop_text_en text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_title text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_keywords text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_description text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS plan_period text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS article_group jsonb DEFAULT '{}'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS outlet_sale boolean DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_promotion boolean DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS webshop_date date;
ALTER TABLE products ADD COLUMN IF NOT EXISTS categories jsonb DEFAULT '[]'::jsonb;

-- Add comments for documentation
COMMENT ON COLUMN products.cost_price IS 'Purchase/cost price (kostprijs)';
COMMENT ON COLUMN products.discount_percentage IS 'Discount percentage (kortings-percentage)';
COMMENT ON COLUMN products.internal_description IS 'Internal description (interne-omschrijving)';
COMMENT ON COLUMN products.webshop_text IS 'Product description in Dutch (webshop-tekst)';
COMMENT ON COLUMN products.webshop_text_en IS 'Product description in English (webshop-tekst-en)';
COMMENT ON COLUMN products.meta_title IS 'SEO meta title';
COMMENT ON COLUMN products.meta_keywords IS 'SEO meta keywords';
COMMENT ON COLUMN products.meta_description IS 'SEO meta description';
COMMENT ON COLUMN products.plan_period IS 'Season/collection period (planperiode)';
COMMENT ON COLUMN products.article_group IS 'Article group with id and description';
COMMENT ON COLUMN products.outlet_sale IS 'Whether this is an outlet/sale product';
COMMENT ON COLUMN products.is_promotion IS 'Whether this product is in promotion';
COMMENT ON COLUMN products.webshop_date IS 'Date when product was added to webshop';
COMMENT ON COLUMN products.categories IS 'Webshop categories (webshop-groep-1 through 8)';

-- Add variant-specific fields
ALTER TABLE variants ADD COLUMN IF NOT EXISTS maat_web text;
ALTER TABLE variants ADD COLUMN IF NOT EXISTS allow_backorder boolean DEFAULT false;

COMMENT ON COLUMN variants.maat_web IS 'Size as displayed on website (maat-web)';
COMMENT ON COLUMN variants.allow_backorder IS 'Whether backorders are allowed for this variant';