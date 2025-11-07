-- Create attribute mappings table
CREATE TABLE IF NOT EXISTS public.attribute_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  attribute_name TEXT NOT NULL,
  code TEXT NOT NULL,
  value TEXT NOT NULL,
  tenant_id UUID REFERENCES public.tenants(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(attribute_name, code, tenant_id)
);

-- Enable RLS
ALTER TABLE public.attribute_mappings ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Authenticated can read attribute mappings"
  ON public.attribute_mappings
  FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage attribute mappings"
  ON public.attribute_mappings
  FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Add trigger for updated_at
CREATE TRIGGER update_attribute_mappings_updated_at
  BEFORE UPDATE ON public.attribute_mappings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Insert common attribute mappings (voorbeeld data - dit kan later uitgebreid worden)
INSERT INTO public.attribute_mappings (attribute_name, code, value, tenant_id) VALUES
-- Bovenmateriaal
('Bovenmateriaal', '001', 'Textiel', NULL),
('Bovenmateriaal', '002', 'Leer', NULL),
('Bovenmateriaal', '003', 'Nubuck', NULL),
('Bovenmateriaal', '004', 'Suède', NULL),
('Bovenmateriaal', '005', 'Synthetisch', NULL),
('Bovenmateriaal', '006', 'Textiel/Synthetisch', NULL),
('Bovenmateriaal', '007', 'Leer/Synthetisch', NULL),

-- Voering
('Voering', '001', 'Textiel', NULL),
('Voering', '002', 'Leer', NULL),
('Voering', '003', 'Synthetisch', NULL),
('Voering', '004', 'Warm gevoerd', NULL),
('Voering', '005', 'Ongevoerd', NULL),
('Voering', '006', 'Leer/Textiel', NULL),
('Voering', '007', 'Gore-Tex', NULL),

-- Binnenzool
('Binnenzool', '001', 'Textiel', NULL),
('Binnenzool', '002', 'Leer', NULL),
('Binnenzool', '003', 'Synthetisch', NULL),
('Binnenzool', '004', 'EVA', NULL),
('Binnenzool', '005', 'Memory Foam', NULL),
('Binnenzool', '006', 'Leer/Textiel', NULL),

-- Loopzool
('Loopzool', '001', 'Rubber', NULL),
('Loopzool', '002', 'EVA', NULL),
('Loopzool', '003', 'PU', NULL),
('Loopzool', '004', 'TPR', NULL),
('Loopzool', '005', 'Vibram', NULL),

-- Sluiting
('Sluiting', '001', 'Veters', NULL),
('Sluiting', '002', 'Rits', NULL),
('Sluiting', '003', 'Klittenband', NULL),
('Sluiting', '004', 'Slip-on', NULL),
('Sluiting', '005', 'Gesp', NULL),
('Sluiting', '006', 'Elastiek', NULL),
('Sluiting', '007', 'Rits en Veters', NULL),
('Sluiting', '008', 'Klittenband en Rits', NULL),
('Sluiting', '009', 'Rits en Elastiek', NULL),

-- Wijdte
('Wijdte', '001', 'Smal', NULL),
('Wijdte', '002', 'Normaal', NULL),
('Wijdte', '003', 'Breed', NULL),
('Wijdte', '004', 'Extra Breed', NULL),
('Wijdte', '005', 'Verstelbaar', NULL),

-- Hakhoogte
('Hakhoogte', '001', 'Plat (0-2cm)', NULL),
('Hakhoogte', '002', 'Laag (2-4cm)', NULL),
('Hakhoogte', '003', 'Middel (4-6cm)', NULL),
('Hakhoogte', '004', 'Hoog (6-8cm)', NULL),
('Hakhoogte', '005', 'Extra Hoog (8cm+)', NULL),

-- Gender
('Gender', '001', 'Dames', NULL),
('Gender', '002', 'Heren', NULL),
('Gender', '003', 'Unisex', NULL),
('Gender', '004', 'Kinderen', NULL),

-- Uitneembaar voetbed
('Uitneembaar voetbed', '001', 'Nee', NULL),
('Uitneembaar voetbed', '002', 'Ja', NULL),
('Uitneembaar voetbed', '003', 'Ja, uitneembaar', NULL),

-- Waterdichtheid
('Waterdichtheid', '001', 'Niet waterdicht', NULL),
('Waterdichtheid', '002', 'Waterafstotend', NULL),
('Waterdichtheid', '003', 'Waterdicht', NULL),
('Waterdichtheid', '004', 'Gore-Tex', NULL),

-- Stretch
('Stretch', '001', 'Nee', NULL),
('Stretch', '002', 'Ja', NULL),
('Stretch', '003', 'Elastisch', NULL),

-- Diabetici
('Diabetici', '001', 'Nee', NULL),
('Diabetici', '002', 'Ja', NULL),
('Diabetici', '003', 'Geschikt', NULL),

-- Hallux Valgus
('Hallux Valgus', '001', 'Nee', NULL),
('Hallux Valgus', '002', 'Ja', NULL),
('Hallux Valgus', '003', 'Geschikt', NULL),

-- Reuma/Artrose
('Reuma/Artrose', '001', 'Nee', NULL),
('Reuma/Artrose', '002', 'Ja', NULL),
('Reuma/Artrose', '003', 'Geschikt', NULL),

-- Peesplaat/Hielspoor
('Peesplaat/Hielspoor', '001', 'Nee', NULL),
('Peesplaat/Hielspoor', '002', 'Ja', NULL),
('Peesplaat/Hielspoor', '003', 'Geschikt', NULL),

-- Zoolstijfheid
('Zoolstijfheid', '001', 'Flexibel', NULL),
('Zoolstijfheid', '002', 'Gemiddeld', NULL),
('Zoolstijfheid', '003', 'Stijf', NULL),
('Zoolstijfheid', '004', 'Extra Stijf', NULL),

-- Kuitwijdte
('Kuitwijdte', '001', 'Normaal', NULL),
('Kuitwijdte', '002', 'Breed', NULL),
('Kuitwijdte', '003', 'Extra Breed', NULL),
('Kuitwijdte', '004', 'Verstelbaar', NULL),

-- Wandelschoentype
('Wandelschoentype', '001', 'Stadswandeling', NULL),
('Wandelschoentype', '002', 'Licht terrein', NULL),
('Wandelschoentype', '003', 'Zwaar terrein', NULL),
('Wandelschoentype', '004', 'Trekking', NULL)
ON CONFLICT (attribute_name, code, tenant_id) DO NOTHING;