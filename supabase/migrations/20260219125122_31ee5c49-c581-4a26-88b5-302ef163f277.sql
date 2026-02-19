
-- ============================================================
-- Fase 1a: pending_product_syncs herstructureren (DROP + CREATE)
-- ============================================================

-- Drop existing table (transient queue data, safe to lose)
DROP TABLE IF EXISTS pending_product_syncs CASCADE;

CREATE TABLE public.pending_product_syncs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL,
  sync_scope TEXT NOT NULL DEFAULT 'PRICE_STOCK',
  priority INT NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ NULL,
  locked_by TEXT NULL,
  payload_hint JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Keep reason for backward compat during transition
  reason TEXT NULL
);

-- Unique constraint for dedupe
ALTER TABLE public.pending_product_syncs
  ADD CONSTRAINT pending_product_syncs_tenant_product_scope_uniq
  UNIQUE (tenant_id, product_id, sync_scope);

-- Indexes for picking and retry
CREATE INDEX idx_pending_syncs_pick
  ON public.pending_product_syncs (tenant_id, status, priority DESC, last_seen_at ASC);

CREATE INDEX idx_pending_syncs_retry
  ON public.pending_product_syncs (status, next_retry_at);

-- RLS
ALTER TABLE public.pending_product_syncs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read pending syncs"
  ON public.pending_product_syncs FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage pending syncs"
  ON public.pending_product_syncs FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- Fase 1b: product_sync_status uitbreiden
-- ============================================================

ALTER TABLE public.product_sync_status
  ADD COLUMN IF NOT EXISTS tenant_id UUID NULL,
  ADD COLUMN IF NOT EXISTS last_synced_at_price_stock TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_synced_at_content TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_synced_at_taxonomy TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_synced_at_media TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_synced_at_variations TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_error TEXT NULL,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ NULL;

-- ============================================================
-- Fase 1c: products tabel uitbreiden
-- ============================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS woocommerce_product_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS woo_permalink TEXT NULL,
  ADD COLUMN IF NOT EXISTS woo_slug TEXT NULL,
  ADD COLUMN IF NOT EXISTS woo_main_image_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS dirty_price_stock BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_content BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_taxonomy BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_media BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_variations BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at_price_stock TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS updated_at_content TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS updated_at_taxonomy TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS updated_at_media TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS updated_at_variations TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_products_new_for_woo
  ON public.products (tenant_id)
  WHERE woocommerce_product_id IS NULL;

-- ============================================================
-- Fase 1d: jobs tabel uitbreiden
-- ============================================================

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS scope TEXT NULL,
  ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS locked_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_priority_pick
  ON public.jobs (state, next_run_at ASC, priority DESC);

-- ============================================================
-- Fase 1e: rate_limit_state tabel
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_state (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id),
  tokens NUMERIC NOT NULL DEFAULT 20,
  capacity INT NOT NULL DEFAULT 20,
  refill_per_minute INT NOT NULL DEFAULT 20,
  penalty_factor NUMERIC NOT NULL DEFAULT 1.0,
  cooldown_until TIMESTAMPTZ NULL,
  last_refill_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.rate_limit_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read rate limit state"
  ON public.rate_limit_state FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage rate limit state"
  ON public.rate_limit_state FOR ALL
  USING (true)
  WITH CHECK (true);

-- Initialize for existing tenants
INSERT INTO public.rate_limit_state (tenant_id, tokens, capacity, refill_per_minute)
SELECT id, 20, 20, 20 FROM public.tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ============================================================
-- Fase 1f: sync_log tabel (audit)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sync_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  job_id UUID NULL,
  product_id UUID NULL,
  scope TEXT NULL,
  request_hash TEXT NULL,
  request_body JSONB NULL,
  response_status INT NULL,
  response_body TEXT NULL,
  duration_ms INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_tenant_time
  ON public.sync_log (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_log_job
  ON public.sync_log (job_id);

ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read sync log"
  ON public.sync_log FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage sync log"
  ON public.sync_log FOR ALL
  USING (true)
  WITH CHECK (true);
