
ALTER TABLE public.google_feed_config
ADD COLUMN fallback_gender text DEFAULT 'unisex',
ADD COLUMN fallback_age_group text DEFAULT 'adult';
