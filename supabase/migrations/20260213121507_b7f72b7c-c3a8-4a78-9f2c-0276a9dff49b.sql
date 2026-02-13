
-- Table for centrally managed attribute definitions and their allowed values
CREATE TABLE public.attribute_definitions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL UNIQUE,
  allowed_values text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.attribute_definitions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Authenticated can read attribute definitions"
  ON public.attribute_definitions FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage attribute definitions"
  ON public.attribute_definitions FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Trigger for updated_at
CREATE TRIGGER update_attribute_definitions_updated_at
  BEFORE UPDATE ON public.attribute_definitions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Seed with current known attributes and values
INSERT INTO public.attribute_definitions (name, allowed_values, sort_order) VALUES
  ('Gender', ARRAY['Dames','Heren','Unisex','Kinderen','Meisjes','Jongens'], 1),
  ('Wijdte', ARRAY['NVT','F','G','G.5','H','H.5','K','M'], 2),
  ('Sluiting', ARRAY['NVT','Instap','Gesp','Veter','Rits','Klittenband','Veter met 1 Rits','Veter met 2 Ritsen'], 3),
  ('Bovenmateriaal', ARRAY['Leer','Nubuck','Suede','Textiel','Synthetisch','Combimaterialen leer'], 4),
  ('Voering', ARRAY['Leer','Textiel','Synthetisch','Onge voerd'], 5),
  ('Binnenzool', ARRAY['Leer','Textiel','Synthetisch'], 6),
  ('Loopzool', ARRAY['Rubber','Leer','Synthetisch','Overige'], 7),
  ('Hakhoogte', ARRAY['NVT','0-1 cm','1-2 cm','2-4 cm','4-6 cm','6+ cm'], 8),
  ('Uitneembaar voetbed', ARRAY['NVT','Hele zool','Halve zool','Ja'], 9),
  ('Waterdichtheid', ARRAY['NVT','Waterafstotend','Waterdicht','GORE-TEX'], 10),
  ('Wandelschoentype', ARRAY['NVT','Licht wandelen','Dagwandeling','Bergtocht'], 11),
  ('Zoolstijfheid', ARRAY['NVT','Flex','Half Flex','Stijf'], 12),
  ('Kuitwijdte', ARRAY['NVT','Normaal','Wijd','Extra wijd','XL','XXL'], 13),
  ('Stretch', ARRAY['NVT','Ja','Nee'], 14),
  ('Hallux Valgus', ARRAY['NVT','Ja'], 15),
  ('Diabetici', ARRAY['NVT','Ja'], 16),
  ('Reuma/Artrose', ARRAY['NVT','Ja'], 17),
  ('Peesplaat/Hielspoor', ARRAY['NVT','Ja'], 18);
