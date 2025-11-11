-- Enable RLS op de nieuwe pending_product_syncs tabel
ALTER TABLE pending_product_syncs ENABLE ROW LEVEL SECURITY;

-- Policy voor service role (de triggers en cron jobs)
CREATE POLICY "Service role can manage pending syncs"
ON pending_product_syncs
FOR ALL
USING (true)
WITH CHECK (true);

-- Policy voor authenticated users om te kunnen lezen
CREATE POLICY "Authenticated can read pending syncs"
ON pending_product_syncs
FOR SELECT
USING (true);