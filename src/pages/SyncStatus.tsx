import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { TenantSelector } from "@/components/TenantSelector";
import { StatCard } from "@/components/StatCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Link2, CheckCircle2, Clock, AlertTriangle, Unlink,
  ChevronDown, ChevronRight, Search, RefreshCw, RotateCcw, ExternalLink, Loader2,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SyncRow {
  id: string;
  sku: string;
  title: string;
  tenant_id: string | null;
  dirty_price_stock: boolean;
  dirty_content: boolean;
  dirty_taxonomy: boolean;
  dirty_media: boolean;
  dirty_variations: boolean;
  modis_updated_at: string;
  woocommerce_product_id: number | null;
  woo_id: number | null;
  permalink: string | null;
  last_pushed_at: string | null;
  woo_linked: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  sync_count: number | null;
  queue_status: "pending" | "error" | null;
  attempts: number;
  sync_scopes: string[] | null;
  next_retry_at: string | null;
}

interface Stats {
  linked: number;
  synced: number;
  pending: number;
  failed: number;
  unlinked: number;
}

type Filter = "all" | "pending" | "errors" | "unlinked" | "dirty";

type SortColumn = "title" | "last_synced_at" | "modis_updated_at" | "last_pushed_at" | "attempts";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTs(ts: string | null) {
  if (!ts) return "—";
  return format(new Date(ts), "dd-MM-yyyy HH:mm");
}

function statusBadge(row: SyncRow) {
  if (!row.woo_linked)
    return <Badge variant="secondary" className="bg-muted text-muted-foreground"><Unlink className="h-3 w-3 mr-1" />Niet gekoppeld</Badge>;
  if (row.queue_status === "error")
    return <Badge variant="destructive"><AlertTriangle className="h-3 w-3 mr-1" />Gefaald</Badge>;
  if (row.queue_status === "pending")
    return <Badge className="bg-orange-500/15 text-orange-600 border-orange-300"><Clock className="h-3 w-3 mr-1" />In queue</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-300"><CheckCircle2 className="h-3 w-3 mr-1" />Gesynchroniseerd</Badge>;
}

const SCOPE_LABELS: Record<string, string> = {
  price_stock: "Prijs",
  content: "Content",
  media: "Media",
  taxonomy: "Taxonomie",
  variations: "Variaties",
};

function ScopePills({ row }: { row: SyncRow }) {
  const scopes = [
    { key: "price_stock", dirty: row.dirty_price_stock },
    { key: "content", dirty: row.dirty_content },
    { key: "media", dirty: row.dirty_media },
    { key: "taxonomy", dirty: row.dirty_taxonomy },
    { key: "variations", dirty: row.dirty_variations },
  ];
  return (
    <div className="flex gap-1 flex-wrap">
      {scopes.map((s) => (
        <span
          key={s.key}
          className={cn(
            "text-[11px] px-1.5 py-0.5 rounded-md font-medium",
            s.dirty
              ? "bg-orange-500/15 text-orange-600"
              : "bg-emerald-500/15 text-emerald-600"
          )}
        >
          {SCOPE_LABELS[s.key]}
        </span>
      ))}
    </div>
  );
}

// ─── Page Component ──────────────────────────────────────────────────────────

const SyncStatus = () => {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortColumn>("modis_updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const queryClient = useQueryClient();

  const toggleSort = (col: SortColumn) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
    setPage(0);
  };

  // Reset page when filter/search changes
  useEffect(() => { setPage(0); }, [filter, search, tenantId]);

  // ── Stats ────────────────────────────────────────────────────────────────
  const { data: stats } = useQuery<Stats>({
    queryKey: ["sync-stats", tenantId],
    enabled: !!tenantId,
    refetchInterval: 15000,
    queryFn: async () => {
      const [linked, unlinked, pending, failed] = await Promise.all([
        supabase.from("woo_products").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId!).not("product_id", "is", null),
        supabase.from("woo_products").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId!).is("product_id", null),
        supabase.from("pending_product_syncs").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId!).eq("status", "PENDING"),
        supabase.from("pending_product_syncs").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId!).eq("status", "error"),
      ]);
      const l = linked.count ?? 0;
      const p = pending.count ?? 0;
      const f = failed.count ?? 0;
      const u = unlinked.count ?? 0;
      return { linked: l, synced: Math.max(0, l - p - f), pending: p, failed: f, unlinked: u };
    },
  });

  // ── Data ─────────────────────────────────────────────────────────────────
  const { data: rows, isLoading } = useQuery<SyncRow[]>({
    queryKey: ["sync-status-rows", tenantId, filter, search, page],
    enabled: !!tenantId,
    queryFn: async () => {
      let query = supabase.from("v_sync_status" as any).select("*").eq("tenant_id", tenantId!);

      if (search.trim()) {
        query = query.or(`sku.ilike.%${search.trim()}%,title.ilike.%${search.trim()}%`);
      }

      switch (filter) {
        case "pending": query = query.eq("queue_status", "pending"); break;
        case "errors": query = query.eq("queue_status", "error"); break;
        case "unlinked": query = query.eq("woo_linked", false); break;
        case "dirty": query = query.or("dirty_price_stock.eq.true,dirty_content.eq.true,dirty_taxonomy.eq.true,dirty_media.eq.true,dirty_variations.eq.true"); break;
      }

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, error } = await query.range(from, to).order("attempts", { ascending: false }).order("modis_updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as SyncRow[];
    },
  });

  // ── Realtime ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!tenantId) return;
    const channel = supabase
      .channel("sync-status-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "pending_product_syncs" }, () => {
        queryClient.invalidateQueries({ queryKey: ["sync-stats", tenantId] });
        queryClient.invalidateQueries({ queryKey: ["sync-status-rows", tenantId] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [tenantId, queryClient]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const forceSync = useCallback(async (productId: string) => {
    setActionLoading(productId + "-sync");
    try {
      const { data, error } = await supabase.functions.invoke("push-to-woocommerce", {
        body: { tenantId, productIds: [productId], syncScope: "FULL" },
      });
      if (error) throw error;
      toast.success("Sync succesvol afgerond");
      queryClient.invalidateQueries({ queryKey: ["sync-status-rows"] });
      queryClient.invalidateQueries({ queryKey: ["sync-stats", tenantId] });
    } catch (e: any) {
      toast.error("Sync mislukt: " + (e?.message || String(e)));
    } finally {
      setActionLoading(null);
    }
  }, [queryClient, tenantId]);

  const resetAttempts = useCallback(async (productId: string) => {
    setActionLoading(productId + "-reset");
    try {
      const { error } = await supabase
        .from("pending_product_syncs")
        .update({ attempts: 0, status: "PENDING", next_retry_at: null } as any)
        .eq("product_id", productId);
      if (error) throw error;
      toast.success("Pogingen gereset");
      queryClient.invalidateQueries({ queryKey: ["sync-status-rows"] });
      queryClient.invalidateQueries({ queryKey: ["sync-stats"] });
    } catch (e: any) {
      toast.error("Reset mislukt: " + e.message);
    } finally {
      setActionLoading(null);
    }
  }, [queryClient]);

  // ── Filter pills ────────────────────────────────────────────────────────
  const filters: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "Alle producten" },
    { key: "pending", label: "Pending", count: stats?.pending },
    { key: "errors", label: "Fouten", count: stats?.failed },
    { key: "unlinked", label: "Niet gekoppeld", count: stats?.unlinked },
    { key: "dirty", label: "Dirty flags" },
  ];

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Sync Status</h1>
            <p className="text-sm text-muted-foreground">Overzicht synchronisatiestatus PIM ↔ WooCommerce</p>
          </div>
          <TenantSelector value={tenantId} onChange={setTenantId} />
        </div>

        {tenantId && (
          <>
            {/* Stats cards */}
            <div className="grid grid-cols-5 gap-4">
              <StatCard title="Gekoppeld" value={stats?.linked ?? "—"} icon={Link2} />
              <StatCard title="Gesynchroniseerd" value={stats?.synced ?? "—"} icon={CheckCircle2} />
              <StatCard title="Pending" value={stats?.pending ?? "—"} icon={Clock} />
              <StatCard title="Gefaald" value={stats?.failed ?? "—"} icon={AlertTriangle} />
              <StatCard title="Niet gekoppeld" value={stats?.unlinked ?? "—"} icon={Unlink} />
            </div>

            {/* Filter bar */}
            <div className="flex items-center gap-3">
              <div className="flex gap-1">
                {filters.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={cn(
                      "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                      filter === f.key
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    )}
                  >
                    {f.label}
                    {f.count != null && f.count > 0 && (
                      <span className="ml-1.5 bg-background/20 px-1.5 rounded-full">{f.count}</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="relative ml-auto w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Zoek op SKU of naam..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
            </div>

            {/* Table */}
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Product</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Scopes</TableHead>
                    <TableHead>Laatste sync</TableHead>
                    <TableHead>Modis wijziging</TableHead>
                    <TableHead>WooCommerce wijziging</TableHead>
                    <TableHead className="text-right">Pogingen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Laden...
                      </TableCell>
                    </TableRow>
                  )}
                  {!isLoading && rows?.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                        Geen producten gevonden voor dit filter
                      </TableCell>
                    </TableRow>
                  )}
                  {rows?.map((row) => {
                    const isOpen = expandedId === row.id;
                    return (
                      <Collapsible key={row.id} open={isOpen} onOpenChange={(o) => setExpandedId(o ? row.id : null)} asChild>
                        <>
                          <CollapsibleTrigger asChild>
                            <TableRow className="cursor-pointer">
                              <TableCell className="w-8 px-2">
                                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </TableCell>
                              <TableCell>
                                <div className="font-medium text-sm">{row.title}</div>
                                <div className="text-xs text-muted-foreground">{row.sku}</div>
                              </TableCell>
                              <TableCell>{statusBadge(row)}</TableCell>
                              <TableCell><ScopePills row={row} /></TableCell>
                              <TableCell className="text-xs">{formatTs(row.last_synced_at)}</TableCell>
                              <TableCell className="text-xs">{formatTs(row.modis_updated_at)}</TableCell>
                              <TableCell className="text-xs">{formatTs(row.last_pushed_at)}</TableCell>
                              <TableCell className="text-right">
                                <span className={cn("font-mono text-xs", row.attempts >= 3 && "text-destructive font-bold")}>
                                  {row.attempts}
                                </span>
                              </TableCell>
                            </TableRow>
                          </CollapsibleTrigger>
                          <CollapsibleContent asChild>
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableCell colSpan={8}>
                                <div className="py-3 px-4 space-y-3">
                                  {/* Details grid */}
                                  <div className="grid grid-cols-4 gap-4 text-xs">
                                    <div>
                                      <span className="text-muted-foreground">WooCommerce ID:</span>{" "}
                                      <span className="font-mono">{row.woo_id ?? "—"}</span>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Sync count:</span>{" "}
                                      <span className="font-mono">{row.sync_count ?? 0}</span>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Scopes in queue:</span>{" "}
                                      <span className="font-mono">{row.sync_scopes?.join(", ") ?? "geen"}</span>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Volgende retry:</span>{" "}
                                      <span className="font-mono">{formatTs(row.next_retry_at)}</span>
                                    </div>
                                  </div>

                                  {/* Dirty flags */}
                                  <div className="flex gap-3 text-xs">
                                    <span className="text-muted-foreground">Dirty flags:</span>
                                    {[
                                      { label: "price_stock", val: row.dirty_price_stock },
                                      { label: "content", val: row.dirty_content },
                                      { label: "taxonomy", val: row.dirty_taxonomy },
                                      { label: "media", val: row.dirty_media },
                                      { label: "variations", val: row.dirty_variations },
                                    ].map((d) => (
                                      <span key={d.label} className={cn("font-mono", d.val ? "text-orange-600" : "text-muted-foreground/50")}>
                                        {d.label}: {d.val ? "✓" : "—"}
                                      </span>
                                    ))}
                                  </div>

                                  {/* Error */}
                                  {row.last_error && (
                                    <div className="bg-destructive/10 text-destructive text-xs rounded-md p-2 font-mono">
                                      {row.last_error}
                                    </div>
                                  )}

                                  {/* Action buttons */}
                                  <div className="flex gap-2 pt-1">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => { e.stopPropagation(); forceSync(row.id); }}
                                      disabled={actionLoading === row.id + "-sync"}
                                    >
                                      {actionLoading === row.id + "-sync" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                                      Forceer sync
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => { e.stopPropagation(); resetAttempts(row.id); }}
                                      disabled={actionLoading === row.id + "-reset"}
                                    >
                                      {actionLoading === row.id + "-reset" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                      Reset pogingen
                                    </Button>
                                    {row.permalink && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={(e) => { e.stopPropagation(); window.open(row.permalink!, "_blank"); }}
                                      >
                                        <ExternalLink className="h-3 w-3" />
                                        Bekijk in WooCommerce
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          </CollapsibleContent>
                        </>
                      </Collapsible>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Load more */}
            {rows && rows.length === PAGE_SIZE && (
              <div className="flex justify-center">
                <Button variant="outline" onClick={() => setPage((p) => p + 1)}>
                  Laad meer
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
};

export default SyncStatus;
