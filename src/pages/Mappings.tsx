import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Map, Tag, Layers, ShoppingCart } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { WooCategoryMappingsPanel } from "@/components/mappings/WooCategoryMappingsPanel";

const Mappings = () => {
  const { data: attributeMappings } = useQuery({
    queryKey: ["attribute-mappings-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("attribute_mappings")
        .select("*", { count: "exact", head: true });
      return count ?? 0;
    },
  });

  const { data: categoryMappings } = useQuery({
    queryKey: ["category-mappings-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("google_category_mappings")
        .select("*", { count: "exact", head: true });
      return count ?? 0;
    },
  });

  const { data: wooCategoryMappings } = useQuery({
    queryKey: ["woo-category-mappings-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("woo_category_mappings")
        .select("*", { count: "exact", head: true });
      return count ?? 0;
    },
  });

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1>Mappings & Rules</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configureer hoe productdata wordt vertaald naar channel-specifieke velden.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="card-interactive">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Attribute Mappings</CardTitle>
              <Tag className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{attributeMappings ?? "—"}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Code → waarde vertalingen voor productattributen
              </p>
            </CardContent>
          </Card>

          <Card className="card-interactive">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Google Category Mappings</CardTitle>
              <Layers className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{categoryMappings ?? "—"}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Artikelgroep → Google Shopping categorie
              </p>
            </CardContent>
          </Card>

          <Card className="card-interactive">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">WooCommerce Categorie Mappings</CardTitle>
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{wooCategoryMappings ?? "—"}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Modis categorie → WooCommerce categorie
              </p>
            </CardContent>
          </Card>
        </div>

        {/* WooCommerce Category Mappings Panel */}
        <WooCategoryMappingsPanel />
      </div>
    </Layout>
  );
};

export default Mappings;
