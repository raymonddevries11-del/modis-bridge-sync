import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { TenantSelector } from "@/components/TenantSelector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Image,
  DollarSign,
  FileText,
  Tag,
  Layers,
  PackageX,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowRight,
  TrendingUp,
  Shield,
  BarChart3,
} from "lucide-react";
import { calculateCompleteness } from "@/lib/completeness";

interface ValidationIssue {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  severity: "critical" | "warning" | "info";
  count: number;
  total: number;
  productIds: string[];
}

const Validation = () => {
  const [selectedTenant, setSelectedTenant] = useState<string>("");
  const navigate = useNavigate();

  const { data: tenants } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("*")
        .eq("active", true)
        .order("name");
      return data || [];
    },
  });

  useEffect(() => {
    if (tenants && tenants.length > 0 && !selectedTenant) {
      setSelectedTenant(tenants[0].id);
    }
  }, [tenants, selectedTenant]);

  // Fetch all products with related data using batching to avoid 1000 row limit
  const { data: products, isLoading } = useQuery({
    queryKey: ["validation-products", selectedTenant],
    queryFn: async () => {
      if (!selectedTenant) return [];

      const allProducts: any[] = [];
      let offset = 0;
      const batchSize = 1000;

      while (true) {
        const { data, error } = await supabase
          .from("products")
          .select(`
            id, sku, title, images, webshop_text, meta_title, meta_description, brand_id, tags,
            brands(id, name),
            product_prices(*),
            variants(id, size_label, stock_totals(*))
          `)
          .eq("tenant_id", selectedTenant)
          .range(offset, offset + batchSize - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;
        allProducts.push(...data);
        if (data.length < batchSize) break;
        offset += batchSize;
      }

      return allProducts;
    },
    enabled: !!selectedTenant,
  });

  // Fetch Google category mappings to detect unmapped article groups
  const { data: categoryMappings } = useQuery({
    queryKey: ["validation-category-mappings", selectedTenant],
    queryFn: async () => {
      if (!selectedTenant) return [];
      const { data } = await supabase
        .from("google_category_mappings")
        .select("article_group_id")
        .eq("tenant_id", selectedTenant);
      return data || [];
    },
    enabled: !!selectedTenant,
  });

  const issues = useMemo<ValidationIssue[]>(() => {
    if (!products) return [];

    const mappedGroupIds = new Set(categoryMappings?.map((m) => m.article_group_id) || []);

    const missingImages: string[] = [];
    const zeroPrice: string[] = [];
    const noDescription: string[] = [];
    const noMetaTitle: string[] = [];
    const noMetaDescription: string[] = [];
    const noBrand: string[] = [];
    const noVariants: string[] = [];
    const noStock: string[] = [];
    const unmappedCategory: string[] = [];

    for (const p of products) {
      const imgs = Array.isArray(p.images) ? p.images : [];
      if (imgs.length === 0) missingImages.push(p.id);

      const price = Number(p.product_prices?.regular || 0);
      if (price === 0) zeroPrice.push(p.id);

      if (!p.webshop_text?.trim()) noDescription.push(p.id);
      if (!p.meta_title?.trim()) noMetaTitle.push(p.id);
      if (!p.meta_description?.trim()) noMetaDescription.push(p.id);
      if (!p.brands?.name) noBrand.push(p.id);

      const variants = p.variants || [];
      if (variants.length === 0) noVariants.push(p.id);

      const hasStock = variants.some((v: any) => v.stock_totals?.qty > 0);
      if (!hasStock) noStock.push(p.id);

      const groupId = (p as any).article_group?.id;
      if (groupId && !mappedGroupIds.has(groupId)) {
        unmappedCategory.push(p.id);
      }
    }

    const total = products.length;

    return [
      {
        id: "missing-images",
        label: "Geen afbeeldingen",
        description: "Producten zonder afbeeldingen worden niet getoond in feeds.",
        icon: Image,
        severity: "critical",
        count: missingImages.length,
        total,
        productIds: missingImages,
      },
      {
        id: "zero-price",
        label: "Prijs = €0",
        description: "Producten met prijs 0 worden uitgesloten van Google Shopping.",
        icon: DollarSign,
        severity: "critical",
        count: zeroPrice.length,
        total,
        productIds: zeroPrice,
      },
      {
        id: "no-description",
        label: "Geen omschrijving",
        description: "Ontbrekende webshop tekst vermindert SEO en conversie.",
        icon: FileText,
        severity: "warning",
        count: noDescription.length,
        total,
        productIds: noDescription,
      },
      {
        id: "no-meta-title",
        label: "Geen meta titel",
        description: "Meta titels zijn essentieel voor SEO ranking.",
        icon: Tag,
        severity: "warning",
        count: noMetaTitle.length,
        total,
        productIds: noMetaTitle,
      },
      {
        id: "no-meta-description",
        label: "Geen meta description",
        description: "Meta descriptions verbeteren CTR in zoekresultaten.",
        icon: Tag,
        severity: "info",
        count: noMetaDescription.length,
        total,
        productIds: noMetaDescription,
      },
      {
        id: "no-brand",
        label: "Geen merk",
        description: "Merk is verplicht voor Google Shopping feeds.",
        icon: Shield,
        severity: "warning",
        count: noBrand.length,
        total,
        productIds: noBrand,
      },
      {
        id: "no-variants",
        label: "Geen varianten",
        description: "Producten zonder varianten kunnen niet besteld worden.",
        icon: Layers,
        severity: "critical",
        count: noVariants.length,
        total,
        productIds: noVariants,
      },
      {
        id: "no-stock",
        label: "Geen voorraad",
        description: "Alle varianten zijn op 0 — product is niet leverbaar.",
        icon: PackageX,
        severity: "info",
        count: noStock.length,
        total,
        productIds: noStock,
      },
      {
        id: "unmapped-category",
        label: "Geen Google categorie",
        description: "Artikelgroep heeft geen Google Product Category mapping.",
        icon: BarChart3,
        severity: "warning",
        count: unmappedCategory.length,
        total,
        productIds: unmappedCategory,
      },
    ];
  }, [products, categoryMappings]);

  const criticalCount = issues.filter((i) => i.severity === "critical").reduce((s, i) => s + i.count, 0);
  const warningCount = issues.filter((i) => i.severity === "warning").reduce((s, i) => s + i.count, 0);
  const totalProducts = products?.length || 0;

  // Compute average completeness
  const avgScore = useMemo(() => {
    if (!products || products.length === 0) return 0;
    const sum = products.reduce((s: number, p: any) => s + calculateCompleteness(p).score, 0);
    return Math.round(sum / products.length);
  }, [products]);

  const severityConfig = {
    critical: { color: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/20", badge: "destructive" as const },
    warning: { color: "text-warning", bg: "bg-warning/10", border: "border-warning/20", badge: "secondary" as const },
    info: { color: "text-muted-foreground", bg: "bg-muted", border: "border-border", badge: "outline" as const },
  };

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Validation Dashboard</h1>
            <p className="text-muted-foreground">
              Feed-health overzicht — identificeer en fix dataproblemen
            </p>
          </div>
          <TenantSelector value={selectedTenant} onChange={setSelectedTenant} />
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Producten analyseren...</p>
          </div>
        ) : (
          <>
            {/* Summary row */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
                      <TrendingUp className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{avgScore}%</p>
                      <p className="text-xs text-muted-foreground">Gemiddelde score</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-destructive/10 flex items-center justify-center">
                      <XCircle className="h-5 w-5 text-destructive" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{criticalCount}</p>
                      <p className="text-xs text-muted-foreground">Kritieke issues</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-warning/10 flex items-center justify-center">
                      <AlertTriangle className="h-5 w-5 text-warning" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{warningCount}</p>
                      <p className="text-xs text-muted-foreground">Waarschuwingen</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-success/10 flex items-center justify-center">
                      <CheckCircle2 className="h-5 w-5 text-success" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{totalProducts}</p>
                      <p className="text-xs text-muted-foreground">Totaal geanalyseerd</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Issue cards */}
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Issues per categorie</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {issues.map((issue) => {
                  const config = severityConfig[issue.severity];
                  const pct = issue.total > 0 ? Math.round((issue.count / issue.total) * 100) : 0;
                  const healthPct = 100 - pct;

                  return (
                    <Card
                      key={issue.id}
                      className={`border ${issue.count > 0 ? config.border : "border-success/20"} transition-all hover:shadow-md`}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`h-9 w-9 rounded-lg ${issue.count > 0 ? config.bg : "bg-success/10"} flex items-center justify-center`}>
                              <issue.icon className={`h-4 w-4 ${issue.count > 0 ? config.color : "text-success"}`} />
                            </div>
                            <div>
                              <CardTitle className="text-sm font-semibold">{issue.label}</CardTitle>
                              <p className="text-xs text-muted-foreground mt-0.5">{issue.description}</p>
                            </div>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex items-end justify-between">
                          <div>
                            <span className={`text-2xl font-bold ${issue.count > 0 ? config.color : "text-success"}`}>
                              {issue.count}
                            </span>
                            <span className="text-sm text-muted-foreground ml-1">/ {issue.total}</span>
                          </div>
                          <Badge variant={issue.count > 0 ? config.badge : "outline"} className="text-xs">
                            {issue.count > 0 ? `${pct}% getroffen` : "✓ OK"}
                          </Badge>
                        </div>

                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div>
                                <Progress
                                  value={healthPct}
                                  className="h-2"
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{healthPct}% gezond — {issue.count} producten met issue</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>

                        {issue.count > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-between text-xs"
                            onClick={() => {
                              // Navigate to products filtered — for now just go to products list
                              navigate("/products");
                            }}
                          >
                            Bekijk getroffen producten
                            <ArrowRight className="h-3 w-3" />
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* Overall health bar */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Catalogus gezondheid</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {issues
                    .filter((i) => i.severity === "critical" || i.severity === "warning")
                    .sort((a, b) => b.count - a.count)
                    .map((issue) => {
                      const pct = issue.total > 0 ? Math.round((issue.count / issue.total) * 100) : 0;
                      const config = severityConfig[issue.severity];
                      return (
                        <div key={issue.id} className="flex items-center gap-4">
                          <div className="w-40 flex items-center gap-2 flex-shrink-0">
                            <issue.icon className={`h-4 w-4 ${config.color}`} />
                            <span className="text-sm font-medium truncate">{issue.label}</span>
                          </div>
                          <div className="flex-1">
                            <Progress value={100 - pct} className="h-2" />
                          </div>
                          <span className={`text-sm font-semibold w-16 text-right ${config.color}`}>
                            {issue.count}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </Layout>
  );
};

export default Validation;
