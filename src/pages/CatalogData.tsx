import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Tag, Layers, Package, ExternalLink } from "lucide-react";
import { AttributeManager } from "@/components/catalog/AttributeManager";

interface AttrInfo {
  name: string;
  values: Set<string>;
  valueCounts: Map<string, number>;
  count: number;
}

const CatalogData = () => {
  const navigate = useNavigate();
  const [catSearch, setCatSearch] = useState("");

  // Fetch all attributes with values
  const { data: attrData, isLoading: attrLoading } = useQuery({
    queryKey: ["catalog-attributes"],
    queryFn: async () => {
      const attrMap = new Map<string, AttrInfo>();
      let offset = 0;
      const BATCH = 1000;

      while (true) {
        const { data, error } = await supabase
          .from("products")
          .select("attributes")
          .not("attributes", "is", null)
          .range(offset, offset + BATCH - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;

        for (const p of data) {
          const attrs = p.attributes as Record<string, any> | null;
          if (!attrs) continue;
          for (const [key, val] of Object.entries(attrs)) {
            if (!key || key === "-") continue;
            if (!attrMap.has(key)) {
              attrMap.set(key, { name: key, values: new Set(), valueCounts: new Map(), count: 0 });
            }
            const info = attrMap.get(key)!;
            info.count++;
            if (val && typeof val === "string" && val.trim()) {
              // Split comma-separated values
              val.split(",").forEach((v: string) => {
                const trimmed = v.trim();
                if (trimmed) {
                  info.values.add(trimmed);
                  info.valueCounts.set(trimmed, (info.valueCounts.get(trimmed) || 0) + 1);
                }
              });
            }
          }
        }

        if (data.length < BATCH) break;
        offset += BATCH;
      }

      return Array.from(attrMap.values()).sort((a, b) => b.count - a.count);
    },
  });

  // Fetch all categories
  const { data: catData, isLoading: catLoading } = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: async () => {
      const catCount = new Map<string, number>();
      let offset = 0;
      const BATCH = 1000;

      while (true) {
        const { data, error } = await supabase
          .from("products")
          .select("categories")
          .not("categories", "is", null)
          .range(offset, offset + BATCH - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;

        for (const p of data) {
          const cats = p.categories as any[];
          if (!Array.isArray(cats)) continue;
          for (const cat of cats) {
            const label = typeof cat === "string" ? cat : (cat?.name ? `${cat.name}` : JSON.stringify(cat));
            if (!label || label === "[]") continue;
            catCount.set(label, (catCount.get(label) || 0) + 1);
          }
        }

        if (data.length < BATCH) break;
        offset += BATCH;
      }

      return Array.from(catCount.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    },
  });

  const filteredCats = catData?.filter((c) =>
    c.name.toLowerCase().includes(catSearch.toLowerCase())
  );

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Catalogus Data</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Overzicht van alle attributen, waarden en categorieën in gebruik
          </p>
        </div>

        <Tabs defaultValue="attributes">
          <TabsList>
            <TabsTrigger value="attributes" className="gap-2">
              <Layers className="h-4 w-4" />
              Attributen ({attrData?.length ?? "..."})
            </TabsTrigger>
            <TabsTrigger value="categories" className="gap-2">
              <Tag className="h-4 w-4" />
              Categorieën ({catData?.length ?? "..."})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="attributes" className="mt-4">
            <AttributeManager usage={attrData} isLoading={attrLoading} />
          </TabsContent>

          <TabsContent value="categories" className="mt-4 space-y-4">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Zoek categorie..."
                value={catSearch}
                onChange={(e) => setCatSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            {catLoading ? (
              <p className="text-sm text-muted-foreground">Laden...</p>
            ) : (
              <div className="grid gap-1">
                {filteredCats?.map((cat) => (
                  <div
                    key={cat.name}
                    className="flex items-center justify-between px-4 py-2.5 bg-card border border-border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => navigate(`/products?category=${encodeURIComponent(cat.name)}`)}
                  >
                    <span className="text-sm">{cat.name}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        <Package className="h-3 w-3 mr-1" />
                        {cat.count}
                      </Badge>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

export default CatalogData;
