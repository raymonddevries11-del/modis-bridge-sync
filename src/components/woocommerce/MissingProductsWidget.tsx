import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Send, Loader2, RefreshCw, Package, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

interface MissingProductsWidgetProps {
  tenantId: string;
}

export const MissingProductsWidget = ({ tenantId }: MissingProductsWidgetProps) => {
  const [pushing, setPushing] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["missing-woo-products", tenantId],
    queryFn: async () => {
      // Count total PIM products
      const { count: pimCount } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      // Count products WITH a woocommerce_product_id (= in WooCommerce)
      const { count: linkedCount } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .not("woocommerce_product_id", "is", null);

      // Get the actual missing products (no woocommerce_product_id)
      const { data: missingProducts } = await supabase
        .from("products")
        .select("id, sku, title")
        .eq("tenant_id", tenantId)
        .is("woocommerce_product_id", null)
        .not("sku", "is", null)
        .order("sku", { ascending: true })
        .limit(200);

      // Also count from woo_products cache
      const { count: wooCacheCount } = await supabase
        .from("woo_products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      return {
        pimCount: pimCount ?? 0,
        linkedCount: linkedCount ?? 0,
        wooCacheCount: wooCacheCount ?? 0,
        missingCount: (pimCount ?? 0) - (linkedCount ?? 0),
        missingProducts: missingProducts ?? [],
      };
    },
    enabled: !!tenantId,
  });

  const handlePushMissing = async () => {
    setPushing(true);
    try {
      const { data: result, error } = await supabase.functions.invoke("sync-new-products", {
        body: { tenantId },
      });
      if (error) throw error;

      if (result?.new_products_found > 0) {
        toast.success(
          `${result.new_products_found} producten gevonden, ${result.jobs_created} jobs aangemaakt` +
          (result.preflight_resolved > 0 ? ` (${result.preflight_resolved} automatisch gekoppeld)` : ""),
          { action: { label: "Bekijk Jobs", onClick: () => navigate("/jobs") } }
        );
      } else if (result?.preflight_resolved > 0) {
        toast.success(`${result.preflight_resolved} producten automatisch gekoppeld aan bestaande WooCommerce producten`);
      } else {
        toast.info("Alle producten bestaan al in WooCommerce of staan in de wachtrij");
      }
      refetch();
    } catch (e: any) {
      toast.error(`Fout: ${e.message}`);
    } finally {
      setPushing(false);
    }
  };

  return (
    <Card className="card-elevated">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Ontbrekende Producten in WooCommerce
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <>
            {/* Counts overview */}
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 rounded-lg bg-muted/50">
                <div className="text-2xl font-semibold">{data.pimCount}</div>
                <div className="text-xs text-muted-foreground">PIM Producten</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted/50">
                <div className="text-2xl font-semibold">{data.linkedCount}</div>
                <div className="text-xs text-muted-foreground">Gekoppeld aan WC</div>
              </div>
              <div className={`text-center p-3 rounded-lg ${data.missingCount > 0 ? "bg-destructive/10" : "bg-muted/50"}`}>
                <div className={`text-2xl font-semibold ${data.missingCount > 0 ? "text-destructive" : "text-success"}`}>
                  {data.missingCount}
                </div>
                <div className="text-xs text-muted-foreground">Ontbrekend</div>
              </div>
            </div>

            {data.wooCacheCount > 0 && (
              <p className="text-xs text-muted-foreground">
                WooCommerce cache bevat {data.wooCacheCount} producten
              </p>
            )}

            {data.missingCount > 0 ? (
              <>
                {/* Push button */}
                <Button
                  onClick={handlePushMissing}
                  disabled={pushing}
                  className="w-full"
                >
                  {pushing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-4 w-4" />
                  )}
                  {pushing ? "Bezig met aanmaken..." : `${data.missingCount} ontbrekende producten naar WooCommerce pushen`}
                </Button>

                {/* Missing products list */}
                <div className="space-y-1">
                  <h4 className="text-sm font-medium flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                    Ontbrekende SKU's ({data.missingProducts.length}{data.missingCount > 200 ? ` van ${data.missingCount}` : ""})
                  </h4>
                  <div className="max-h-60 overflow-y-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 sticky top-0">
                        <tr>
                          <th className="text-left py-1.5 px-3 font-medium">SKU</th>
                          <th className="text-left py-1.5 px-3 font-medium">Titel</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.missingProducts.map((p) => (
                          <tr key={p.id} className="border-t hover:bg-muted/30">
                            <td className="py-1.5 px-3 font-mono text-xs">{p.sku}</td>
                            <td className="py-1.5 px-3 text-xs truncate max-w-[300px]">{p.title}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center gap-2 py-4 text-success">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-medium">Alle producten zijn gekoppeld aan WooCommerce</span>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
};
