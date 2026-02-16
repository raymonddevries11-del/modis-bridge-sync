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
import { CategoryManager } from "@/components/catalog/CategoryManager";
import { CategoryMappingManager } from "@/components/catalog/CategoryMappingManager";
import { WooAttributeSync } from "@/components/mappings/WooAttributeSync";
import { WooAttributeCatalog } from "@/components/catalog/WooAttributeCatalog";
import { TenantSelector } from "@/components/TenantSelector";

interface AttrInfo {
  name: string;
  values: Set<string>;
  valueCounts: Map<string, number>;
  count: number;
}

const CatalogData = () => {
  const navigate = useNavigate();
  const [catSearch, setCatSearch] = useState("");
  const [catSubTab, setCatSubTab] = useState<"overview" | "mapping">("overview");
  const [attrSubTab, setAttrSubTab] = useState<"overview" | "woo-sync" | "woo-catalog">("overview");
  const [tenantId, setTenantId] = useState("");

  // Fetch tenants to auto-select first one
  const { data: tenants } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  // Auto-select first tenant
  if (!tenantId && tenants?.length) {
    setTenantId(tenants[0].id);
  }

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

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Catalogus Data</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Overzicht van alle attributen, waarden en categorieën in gebruik
            </p>
          </div>
          {tenants && tenants.length > 1 && (
            <TenantSelector value={tenantId} onChange={setTenantId} />
          )}
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
            <Tabs value={attrSubTab} onValueChange={(v) => setAttrSubTab(v as any)}>
              <TabsList className="mb-4">
                <TabsTrigger value="overview">Bron (Modis)</TabsTrigger>
                <TabsTrigger value="woo-catalog">WooCommerce Catalogus</TabsTrigger>
                <TabsTrigger value="woo-sync">Mapping & Sync</TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <AttributeManager usage={attrData} isLoading={attrLoading} />
              </TabsContent>

              <TabsContent value="woo-catalog">
                <WooAttributeCatalog />
              </TabsContent>

              <TabsContent value="woo-sync">
                <WooAttributeSync />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="categories" className="mt-4">
            <Tabs value={catSubTab} onValueChange={(v) => setCatSubTab(v as any)}>
              <TabsList className="mb-4">
                <TabsTrigger value="overview">Bron (Modis)</TabsTrigger>
                <TabsTrigger value="mapping">WooCommerce Mapping</TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <CategoryManager categories={catData} isLoading={catLoading} />
              </TabsContent>

              <TabsContent value="mapping">
                {tenantId ? (
                  <CategoryMappingManager
                    categories={catData}
                    isLoading={catLoading}
                    tenantId={tenantId}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Selecteer eerst een tenant.</p>
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

export default CatalogData;
