-- Allow admins to manage stock_totals
CREATE POLICY "Admins can manage stock totals" 
ON public.stock_totals 
FOR ALL 
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));