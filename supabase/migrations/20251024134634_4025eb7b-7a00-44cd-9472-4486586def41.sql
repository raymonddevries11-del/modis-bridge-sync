-- Create table to track exported files for SFTP sync
CREATE TABLE IF NOT EXISTS public.export_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  storage_path text NOT NULL,
  order_number text NOT NULL,
  synced_to_sftp boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  synced_at timestamp with time zone
);

-- Enable RLS
ALTER TABLE public.export_files ENABLE ROW LEVEL SECURITY;

-- Allow all operations (since this is internal system data)
CREATE POLICY "Allow all operations on export_files" 
ON public.export_files 
FOR ALL 
USING (true) 
WITH CHECK (true);