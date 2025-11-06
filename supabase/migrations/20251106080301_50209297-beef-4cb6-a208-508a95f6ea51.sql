-- Allow service role and anon key to read tenants and tenant_config
-- This is needed for the GitHub Actions SFTP sync workflow

-- Drop existing restrictive policy on tenants
DROP POLICY IF EXISTS "Authenticated can read tenants" ON public.tenants;

-- Create new policy that allows both authenticated users and service role to read
CREATE POLICY "Anyone can read tenants"
ON public.tenants
FOR SELECT
USING (true);

-- Add service role policy for tenant_config (in addition to admin policy)
CREATE POLICY "Service role can read tenant config"
ON public.tenant_config
FOR SELECT
USING (true);