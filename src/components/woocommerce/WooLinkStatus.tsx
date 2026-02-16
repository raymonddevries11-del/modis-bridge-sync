import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link2, Unlink, Search, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Package } from "lucide-react";
import { toast } from "sonner";

interface Props {
  tenantId: string;
}

export const WooLinkStatus = ({ tenantId }: Props) => {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const queryClient = useQueryClient();

  // Summary stats
  const { data: summary, isLoading: loadingSummary, refetch: refetchSummary } = useQuery({
    queryKey: ["woo-link-summary", tenantId],
    queryFn: async () => {
      const [totalRes, linkedRes, unlinkableRes] = await Promise.all([
        supabase.from("woo_products").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
        supabase.from("woo_products").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).not("product_id", "is", null),
        // Count unlinked that COULD be matched by SKU
        supabase.rpc("count_linkable_woo_products" as never, { p_tenant_id: tenantId } as never).maybeSingle(),
      ]);

      const total = totalRes.count ?? 0;
      const linked = linkedRes.count ?? 0;
      const unlinked = total - linked;

      return { total, linked, unlinked };
    },
    enabled: !!tenantId,
  });

  // Unlinked products list
  const { data: unlinkedProducts, isLoading: loadingList } = useQuery({
    queryKey: ["woo-unlinked-products", tenantId, search, page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from("woo_products")
        .select("id, woo_id, sku, name, status, last_fetched_at")
        .eq("tenant_id", tenantId)
        .is("product_id", null)
        .order("name", { ascending: true })
        .range(from, to);

      if (search) {
        query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenantId,
  });

  // Count unlinked for pagination
  const { data: unlinkedCount } = useQuery({
    queryKey: ["woo-unlinked-count", tenantId, search],
    queryFn: async () => {
      let query = supabase
        .from("woo_products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("product_id", null);

      if (search) {
        query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%`);
      }

      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!tenantId,
  });

  // Bulk link mutation
  const bulkLinkMutation = useMutation({
    mutationFn: async () => {
      // Get all unlinked woo_products with their SKUs
      const { data: unlinked, error: fetchError } = await supabase
        .from("woo_products")
        .select("id, sku")
        .eq("tenant_id", tenantId)
        .is("product_id", null)
        .not("sku", "is", null);

      if (fetchError) throw fetchError;
      if (!unlinked || unlinked.length === 0) return { linked: 0 };

      // Get all PIM products for matching
      const skus = unlinked.map(u => u.sku).filter(Boolean);
      const { data: pimProducts, error: pimError } = await supabase
        .from("products")
        .select("id, sku")
        .eq("tenant_id", tenantId)
        .in("sku", skus);

      if (pimError) throw pimError;

      const skuToProductId = new Map(pimProducts?.map(p => [p.sku, p.id]) ?? []);

      let linkedCount = 0;
      const BATCH = 100;
      for (let i = 0; i < unlinked.length; i += BATCH) {
        const batch = unlinked.slice(i, i + BATCH);
        for (const wp of batch) {
          const productId = skuToProductId.get(wp.sku!);
          if (productId) {
            const { error } = await supabase
              .from("woo_products")
              .update({ product_id: productId, updated_at: new Date().toISOString() })
              .eq("id", wp.id);
            if (!error) linkedCount++;
          }
        }
      }
      return { linked: linkedCount };
    },
    onSuccess: (data) => {
      if (data.linked > 0) {
        toast.success(`${data.linked} producten gekoppeld op basis van SKU`);
      } else {
        toast.info("Geen producten gevonden om te koppelen");
      }
      queryClient.invalidateQueries({ queryKey: ["woo-link-summary"] });
      queryClient.invalidateQueries({ queryKey: ["woo-unlinked-products"] });
      queryClient.invalidateQueries({ queryKey: ["woo-unlinked-count"] });
      refetchSummary();
    },
    onError: (err: any) => toast.error(`Fout bij koppelen: ${err.message}`),
  });

  const linkPercentage = summary ? Math.round((summary.linked / Math.max(summary.total, 1)) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Package className="h-4 w-4" />
            Totaal WooCommerce
          </div>
          <p className="text-2xl font-semibold">{summary?.total ?? "—"}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link2 className="h-4 w-4 text-success" />
            Gekoppeld
          </div>
          <p className="text-2xl font-semibold text-success">{summary?.linked ?? "—"}</p>
          <p className="text-xs text-muted-foreground">{linkPercentage}%</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Unlink className="h-4 w-4 text-warning" />
            Niet gekoppeld
          </div>
          <p className="text-2xl font-semibold text-warning">{summary?.unlinked ?? "—"}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 flex items-center justify-center">
          <Button
            onClick={() => bulkLinkMutation.mutate()}
            disabled={bulkLinkMutation.isPending || !summary?.unlinked}
            className="w-full"
          >
            {bulkLinkMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Auto-koppel op SKU
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      {summary && summary.total > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Koppelstatus</span>
            <span>{linkPercentage}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${linkPercentage}%` }}
            />
          </div>
        </div>
      )}

      {/* Unlinked products table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Niet-gekoppelde producten</h3>
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Zoek op SKU of naam..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9"
            />
          </div>
        </div>

        {loadingList ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : unlinkedProducts && unlinkedProducts.length > 0 ? (
          <>
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>WooCommerce ID</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Naam</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reden</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unlinkedProducts.map((wp) => (
                    <TableRow key={wp.id}>
                      <TableCell className="font-mono text-xs">{wp.woo_id}</TableCell>
                      <TableCell className="font-mono text-xs">{wp.sku || <span className="text-muted-foreground italic">geen SKU</span>}</TableCell>
                      <TableCell className="max-w-[300px] truncate">{wp.name}</TableCell>
                      <TableCell>
                        <Badge variant={wp.status === "publish" ? "default" : "secondary"}>
                          {wp.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {!wp.sku ? (
                          <span className="flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="h-3 w-3" /> Geen SKU
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-warning">
                            <Unlink className="h-3 w-3" /> SKU niet in PIM
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {unlinkedCount != null && unlinkedCount > PAGE_SIZE && (
              <div className="flex items-center justify-between pt-1">
                <p className="text-xs text-muted-foreground">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, unlinkedCount)} van {unlinkedCount}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                    Vorige
                  </Button>
                  <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= unlinkedCount} onClick={() => setPage(p => p + 1)}>
                    Volgende
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mb-2 text-success" />
            <p className="text-sm font-medium">Alle producten zijn gekoppeld!</p>
          </div>
        )}
      </div>
    </div>
  );
};
