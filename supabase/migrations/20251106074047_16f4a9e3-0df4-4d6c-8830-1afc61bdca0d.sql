-- Create user roles enum
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

-- Create user_roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Enable RLS on user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Create security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- RLS policy: Users can read their own roles
CREATE POLICY "Users can read own roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- RLS policy: Only admins can manage roles
CREATE POLICY "Admins can manage all roles"
ON public.user_roles
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Drop existing permissive RLS policies and create secure ones
-- API Keys: Only admins
DROP POLICY IF EXISTS "Allow all operations on api_keys" ON api_keys;
CREATE POLICY "Admins can manage API keys"
ON api_keys
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Brands: Read for all authenticated, write for admins
DROP POLICY IF EXISTS "Allow all operations on brands" ON brands;
CREATE POLICY "Authenticated can read brands"
ON brands
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can manage brands"
ON brands
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Changelog: Read for all authenticated, write for system
DROP POLICY IF EXISTS "Allow all operations on changelog" ON changelog;
CREATE POLICY "Authenticated can read changelog"
ON changelog
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can write changelog"
ON changelog
FOR INSERT
TO service_role
WITH CHECK (true);

-- Config: Only admins
DROP POLICY IF EXISTS "Allow all operations on config" ON config;
CREATE POLICY "Admins can manage config"
ON config
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Export files: Authenticated users can read
DROP POLICY IF EXISTS "Allow all operations on export_files" ON export_files;
CREATE POLICY "Authenticated can read export files"
ON export_files
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can manage export files"
ON export_files
FOR ALL
TO service_role
WITH CHECK (true);

-- Jobs: Authenticated users can read, service role can manage
DROP POLICY IF EXISTS "Allow all operations on jobs" ON jobs;
CREATE POLICY "Authenticated can read jobs"
ON jobs
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can manage jobs"
ON jobs
FOR ALL
TO service_role
WITH CHECK (true);

-- Orders & Order Lines: Authenticated users can read
DROP POLICY IF EXISTS "Allow all operations on orders" ON orders;
DROP POLICY IF EXISTS "Service role can manage orders" ON orders;
CREATE POLICY "Authenticated can read orders"
ON orders
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can manage orders"
ON orders
FOR ALL
TO service_role
WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all operations on order_lines" ON order_lines;
CREATE POLICY "Authenticated can read order lines"
ON order_lines
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can manage order lines"
ON order_lines
FOR ALL
TO service_role
WITH CHECK (true);

-- Products, Variants, Stock: Authenticated read, admins write
DROP POLICY IF EXISTS "Allow all operations on products" ON products;
CREATE POLICY "Authenticated can read products"
ON products
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can manage products"
ON products
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Allow all operations on product_prices" ON product_prices;
CREATE POLICY "Authenticated can read product prices"
ON product_prices
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can manage product prices"
ON product_prices
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Allow all operations on variants" ON variants;
CREATE POLICY "Authenticated can read variants"
ON variants
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can manage variants"
ON variants
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Allow all operations on stock_by_store" ON stock_by_store;
CREATE POLICY "Authenticated can read stock by store"
ON stock_by_store
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can manage stock by store"
ON stock_by_store
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Allow all operations on stock_totals" ON stock_totals;
CREATE POLICY "Authenticated can read stock totals"
ON stock_totals
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can manage stock totals"
ON stock_totals
FOR ALL
TO service_role
WITH CHECK (true);

-- Suppliers: Authenticated read, admins write
DROP POLICY IF EXISTS "Allow all operations on suppliers" ON suppliers;
CREATE POLICY "Authenticated can read suppliers"
ON suppliers
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can manage suppliers"
ON suppliers
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Tenant Config: Only admins (contains sensitive WooCommerce credentials)
DROP POLICY IF EXISTS "Allow all operations on tenant_config" ON tenant_config;
CREATE POLICY "Admins can manage tenant config"
ON tenant_config
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Tenants: Authenticated read, admins write
DROP POLICY IF EXISTS "Allow all operations on tenants" ON tenants;
CREATE POLICY "Authenticated can read tenants"
ON tenants
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Admins can manage tenants"
ON tenants
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));