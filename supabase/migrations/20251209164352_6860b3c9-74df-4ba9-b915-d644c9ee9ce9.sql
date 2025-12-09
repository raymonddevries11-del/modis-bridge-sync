-- Create product_sync_status table to track when products were last synced
CREATE TABLE public.product_sync_status (
  product_id UUID NOT NULL PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  sync_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.product_sync_status ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Authenticated can read sync status"
ON public.product_sync_status
FOR SELECT
USING (true);

CREATE POLICY "Service role can manage sync status"
ON public.product_sync_status
FOR ALL
WITH CHECK (true);

-- Index for efficient queries on last_synced_at
CREATE INDEX idx_product_sync_status_last_synced ON public.product_sync_status(last_synced_at NULLS FIRST);