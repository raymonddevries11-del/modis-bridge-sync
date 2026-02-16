import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowRight, TrendingUp, TrendingDown, ImageIcon, Tag, Activity, Package, AlertCircle, Clock,
} from "lucide-react";

interface WooDeltaDashboardProps {
  tenantId: string;
}

const changeTypeConfig: Record<string, { label: string; color: string; icon: any }> = {
  price_change: { label: "Prijs", color: "bg-amber-500/15 text-amber-700 border-amber-500/30", icon: TrendingUp },
  stock_change: { label: "Voorraad", color: "bg-blue-500/15 text-blue-700 border-blue-500/30", icon: TrendingDown },
  status_change: { label: "Status", color: "bg-purple-500/15 text-purple-700 border-purple-500/30", icon: Activity },
  content_change: { label: "Content", color: "bg-green-500/15 text-green-700 border-green-500/30", icon: Tag },
  image_change: { label: "Afbeeldingen", color: "bg-pink-500/15 text-pink-700 border-pink-500/30", icon: ImageIcon },
  new_product: { label: "Nieuw", color: "bg-success/15 text-success border-success/30", icon: Package },
};

const fieldLabels: Record<string, string> = {
  regular_price: "Reguliere prijs",
  sale_price: "Actieprijs",
  stock_status: "Voorraadstatus",
  stock_quantity: "Voorraad aantal",
  status: "Publicatiestatus",
  name: "Productnaam",
  slug: "URL slug",
  images: "Afbeeldingen",
  categories: "Categorieën",
  product: "Product",
};

export const WooDeltaDashboard = ({ tenantId }: WooDeltaDashboardProps) => {
  // Fetch recent changes summary
  const { data: changeSummary } = useQuery({
    queryKey: ["woo-delta-summary", tenantId],
    queryFn: async () => {
      // Get change type counts from last fetch
      const { data: recentChanges, error } = await supabase
        .from("woo_product_changes")
        .select("change_type, detected_at")
        .eq("tenant_id", tenantId)
        .order("detected_at", { ascending: false })
        .limit(1000);

      if (error) throw error;
      if (!recentChanges || recentChanges.length === 0) return null;

      // Find the most recent fetch timestamp
      const latestDetected = recentChanges[0]?.detected_at;
      if (!latestDetected) return null;

      // Group changes from latest fetch only
      const latestChanges = recentChanges.filter(c => c.detected_at === latestDetected);
      const typeCounts: Record<string, number> = {};
      for (const c of latestChanges) {
        typeCounts[c.change_type] = (typeCounts[c.change_type] || 0) + 1;
      }

      return {
        lastFetch: latestDetected,
        totalChanges: latestChanges.length,
        typeCounts,
        allTimeChanges: recentChanges.length,
      };
    },
    enabled: !!tenantId,
  });

  // Fetch detailed recent changes
  const { data: recentChanges } = useQuery({
    queryKey: ["woo-delta-recent", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("woo_product_changes")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("detected_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
  });

  // Fetch products with active diffs
  const { data: productsWithDiffs } = useQuery({
    queryKey: ["woo-delta-products", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("woo_products")
        .select("id, woo_id, sku, name, fetch_diff, last_fetched_at")
        .eq("tenant_id", tenantId)
        .not("fetch_diff", "is", null)
        .order("last_fetched_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data?.filter((p: any) => p.fetch_diff?.change_count > 0) || [];
    },
    enabled: !!tenantId,
  });

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString("nl-NL", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

  if (!changeSummary && (!productsWithDiffs || productsWithDiffs.length === 0)) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>Nog geen delta data beschikbaar.</p>
        <p className="text-sm mt-1">Haal eerst producten op uit WooCommerce om wijzigingen te detecteren.</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Summary cards */}
        {changeSummary && (
          <div className="grid gap-3 md:grid-cols-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  <span className="text-sm text-muted-foreground">Totaal wijzigingen</span>
                </div>
                <span className="text-2xl font-semibold mt-1 block">{changeSummary.totalChanges}</span>
                <span className="text-[10px] text-muted-foreground">sinds laatste fetch</span>
              </CardContent>
            </Card>
            {Object.entries(changeSummary.typeCounts).map(([type, count]) => {
              const cfg = changeTypeConfig[type] || { label: type, color: "bg-muted", icon: AlertCircle };
              const Icon = cfg.icon;
              return (
                <Card key={type}>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      <span className="text-sm text-muted-foreground">{cfg.label}</span>
                    </div>
                    <span className="text-2xl font-semibold mt-1 block">{count}</span>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Products with changes */}
        {productsWithDiffs && productsWithDiffs.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Producten met wijzigingen sinds laatste fetch</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Gewijzigde velden</TableHead>
                      <TableHead>Gedetecteerd</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {productsWithDiffs.map((p: any) => {
                      const diff = p.fetch_diff;
                      const changes = diff?.changes || [];
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="font-mono text-xs">{p.sku || "—"}</TableCell>
                          <TableCell>
                            <span className="text-sm truncate block max-w-[200px]">{p.name}</span>
                            <span className="text-[10px] text-muted-foreground">WC #{p.woo_id}</span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {changes.map((c: any, i: number) => {
                                const cfg = changeTypeConfig[c.change_type] || { label: c.change_type, color: "bg-muted" };
                                return (
                                  <Tooltip key={i}>
                                    <TooltipTrigger asChild>
                                      <Badge variant="outline" className={`text-[10px] cursor-help ${cfg.color}`}>
                                        {fieldLabels[c.field] || c.field}
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      <div className="flex items-center gap-1.5 text-xs">
                                        <span className="line-through text-muted-foreground">
                                          {c.old_value || "leeg"}
                                        </span>
                                        <ArrowRight className="h-3 w-3" />
                                        <span className="font-medium">{c.new_value || "leeg"}</span>
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                );
                              })}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              {diff?.detected_at ? formatDate(diff.detected_at) : "—"}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent change log */}
        {recentChanges && recentChanges.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Recente wijzigingen (changelog)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5 max-h-[400px] overflow-auto">
                {recentChanges.map((change: any) => {
                  const cfg = changeTypeConfig[change.change_type] || { label: change.change_type, color: "bg-muted", icon: AlertCircle };
                  return (
                    <div key={change.id} className="flex items-center gap-3 text-sm border rounded-lg px-3 py-2">
                      <Badge variant="outline" className={`text-[10px] shrink-0 ${cfg.color}`}>
                        {cfg.label}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground w-[90px] shrink-0">
                        {change.sku || "—"}
                      </span>
                      <span className="truncate text-sm flex-1">{change.product_name}</span>
                      <span className="text-xs font-medium shrink-0">{fieldLabels[change.field_name] || change.field_name}</span>
                      <div className="flex items-center gap-1 text-xs shrink-0">
                        <span className="text-muted-foreground line-through max-w-[80px] truncate">{change.old_value || "—"}</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span className="text-primary font-medium max-w-[80px] truncate">{change.new_value || "—"}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {formatDate(change.detected_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </TooltipProvider>
  );
};
