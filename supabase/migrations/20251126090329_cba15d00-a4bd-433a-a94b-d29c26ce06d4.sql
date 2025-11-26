-- Drop the database triggers that automatically create sync jobs
DROP TRIGGER IF EXISTS track_price_changes ON product_prices;
DROP TRIGGER IF EXISTS track_stock_changes ON stock_totals;
DROP TRIGGER IF EXISTS trigger_product_attributes_sync ON products;

-- Keep the trigger functions for reference but they won't be called
-- (Not dropping the functions in case we want to re-enable them later)