-- Add foreign key constraint from changelog to tenants
ALTER TABLE public.changelog
ADD CONSTRAINT changelog_tenant_id_fkey
FOREIGN KEY (tenant_id)
REFERENCES public.tenants(id)
ON DELETE CASCADE;