ALTER TABLE public.google_feed_config 
ADD COLUMN shipping_rules jsonb DEFAULT '[]'::jsonb;