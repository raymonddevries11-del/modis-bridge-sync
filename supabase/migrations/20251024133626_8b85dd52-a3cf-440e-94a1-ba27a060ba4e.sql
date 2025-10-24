-- Make the order-exports bucket public for reading
UPDATE storage.buckets 
SET public = true 
WHERE id = 'order-exports';