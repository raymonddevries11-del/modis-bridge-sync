import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers, Tag, Link2, BookOpen } from "lucide-react";
import { AttributeManager } from "@/components/catalog/AttributeManager";
import { CategoryManager } from "@/components/catalog/CategoryManager";
import { CategoryMappingManager } from "@/components/catalog/CategoryMappingManager";
import { WooAttributeSync } from "@/components/mappings/WooAttributeSync";
import { WooAttributeCatalog } from "@/components/catalog/WooAttributeCatalog";
import { CatalogHealthBar } from "@/components/catalog/CatalogHealthBar";
import { TenantSelector } from "@/components/TenantSelector";
import { useCategoryMappings } from "@/hooks/useCategoryMappings";

interface AttrInfo {
  name: string;
  values: Set<string>;
  valueCounts: Map<string, number>;
  count: number;
}

const CatalogData = () => {
  const [activeTab, setActiveTab] = useState("attr-source");
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

  const needsAttrData = activeTab === "attr-source" || activeTab === "attr-mapping";
  const needsCatData = activeTab === "cat-source" || activeTab === "cat-mapping";

  // Fetch all attributes with values — only when attr tabs are active
  const { data: attrData, isLoading: attrLoading } = useQuery({
    queryKey: ["catalog-attributes"],
    enabled: needsAttrData,
    staleTime: 5 * 60 * 1000, // 5 min cache
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

  // Fetch all categories — only when cat tabs are active
  const { data: catData, isLoading: catLoading } = useQuery({
    queryKey: ["catalog-categories"],
    enabled: needsCatData,
    staleTime: 5 * 60 * 1000,
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

  // Fetch WC attribute mappings count for health bar
  const configKey = `woo_attribute_mappings_${tenantId}`;
  const { data: attrMappings } = useQuery({
    queryKey: ["woo-attr-mappings-config", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", configKey)
        .maybeSingle();
      return (data?.value as Record<string, string>) ?? {};
    },
  });

  // Fetch category mappings count for health bar
  const { mappings: catMappings } = useCategoryMappings(tenantId);

  // Compute health stats — show partial data as it becomes available
  const healthStats = tenantId ? {
    totalAttributes: attrData?.length ?? null,
    mappedAttributes: attrMappings ? Object.keys(attrMappings).length : 0,
    totalCategories: catData?.length ?? null,
    mappedCategories: catMappings?.length ?? 0,
  } : null;

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Catalogus Data</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Beheer attributen, categorieën en hun mappings naar WooCommerce
            </p>
          </div>
          <TenantSelector value={tenantId} onChange={setTenantId} />
        </div>

        {/* Health Dashboard */}
        {tenantId && (
          <CatalogHealthBar
            stats={healthStats}
            isLoading={false}
          />
        )}

        {/* Flat single-level navigation */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="attr-source" className="gap-1.5">
              <Layers className="h-3.5 w-3.5" />
              Attributen
            </TabsTrigger>
            <TabsTrigger value="attr-mapping" className="gap-1.5">
              <Link2 className="h-3.5 w-3.5" />
              Attribuut Mapping
            </TabsTrigger>
            <TabsTrigger value="cat-source" className="gap-1.5">
              <Tag className="h-3.5 w-3.5" />
              Categorieën
            </TabsTrigger>
            <TabsTrigger value="cat-mapping" className="gap-1.5">
              <Link2 className="h-3.5 w-3.5" />
              Categorie Mapping
            </TabsTrigger>
            <TabsTrigger value="wc-catalog" className="gap-1.5">
              <BookOpen className="h-3.5 w-3.5" />
              WC Catalogus
            </TabsTrigger>
          </TabsList>

          <TabsContent value="attr-source" className="mt-4">
            <AttributeManager usage={attrData} isLoading={attrLoading} />
          </TabsContent>

          <TabsContent value="attr-mapping" className="mt-4">
            <WooAttributeSync tenantId={tenantId} />
          </TabsContent>

          <TabsContent value="cat-source" className="mt-4">
            <CategoryManager categories={catData} isLoading={catLoading} />
          </TabsContent>

          <TabsContent value="cat-mapping" className="mt-4">
            {tenantId ? (
              <CategoryMappingManager
                categories={catData}
                isLoading={catLoading}
                tenantId={tenantId}
              />
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">Selecteer eerst een tenant.</p>
            )}
          </TabsContent>

          <TabsContent value="wc-catalog" className="mt-4">
            <WooAttributeCatalog tenantId={tenantId} />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

export default CatalogData;