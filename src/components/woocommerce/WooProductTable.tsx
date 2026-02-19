import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-function-client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RefreshCw, Loader2, ExternalLink, Search, Image as ImageIcon, Send, CheckCircle2, XCircle, ArrowRight, Clock,
  ArrowUp, ArrowDown, ArrowUpDown, Filter,
} from "lucide-react";
import { toast } from "sonner";

interface WooProductTableProps {
  tenantId: string;
}

interface FieldChange {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

const fieldLabels: Record<string, string> = {
  name: "Naam",
  description: "Beschrijving",
  regular_price: "Prijs",
  sale_price: "Actieprijs",
  slug: "URL slug",
  images: "Afbeeldingen",
  attributes: "Attributen",
};

const ChangeBadges = ({ pushData }: { pushData: any }) => {
  if (!pushData) return <span className="text-muted-foreground">—</span>;

  const action = pushData.action;
  const fields: FieldChange[] = pushData.fields || [];

  const actionBadge = () => {
    switch (action) {
      case "created":
        return <Badge className="bg-success/15 text-success border-success/30 text-[10px]">Aangemaakt</Badge>;
      case "updated":
        return <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px]">Bijgewerkt</Badge>;
      case "checked":
        return <Badge variant="secondary" className="text-[10px]">Geen wijzigingen</Badge>;
      default:
        return <Badge variant="outline" className="text-[10px]">{action}</Badge>;
    }
  };

  return (
    <TooltipProvider>
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {actionBadge()}
          {fields.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-[10px] cursor-help">
                  {fields.length} veld{fields.length !== 1 ? "en" : ""}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                <div className="space-y-1.5 text-xs">
                  {fields.map((f: FieldChange, i: number) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <span className="font-medium text-foreground">{fieldLabels[f.field] || f.field}:</span>
                      <span className="text-muted-foreground line-through">{f.old_value || "leeg"}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 mt-0.5" />
                      <span className="text-primary">{f.new_value || "leeg"}</span>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {fields.length > 0 && (
          <div className="flex flex-wrap gap-0.5">
            {fields.map((f: FieldChange, i: number) => (
              <span
                key={i}
                className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium bg-primary/10 text-primary"
              >
                {fieldLabels[f.field] || f.field}
              </span>
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
};

export const WooProductTable = ({ tenantId }: WooProductTableProps) => {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<string>("last_fetched_at");
  const [sortAsc, setSortAsc] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushingAll, setPushingAll] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Column filters
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterStock, setFilterStock] = useState<string>("all");
  const [filterPim, setFilterPim] = useState<string>("all");
  const [filterPush, setFilterPush] = useState<string>("all");
  const [filterChanges, setFilterChanges] = useState<string>("all");

  const resetPage = () => setPage(0);

  const applyFilters = (query: any) => {
    if (search) {
      query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%`);
    }
    if (filterStatus !== "all") {
      query = query.eq("status", filterStatus);
    }
    if (filterStock === "instock") {
      query = query.eq("stock_status", "instock");
    } else if (filterStock === "outofstock") {
      query = query.eq("stock_status", "outofstock");
    } else if (filterStock === "has_stock") {
      query = query.gt("stock_quantity", 0);
    } else if (filterStock === "no_stock") {
      query = query.or("stock_quantity.is.null,stock_quantity.eq.0");
    }
    if (filterPim === "synced") {
      query = query.not("product_id", "is", null);
    } else if (filterPim === "unsynced") {
      query = query.is("product_id", null);
    }
    if (filterPush === "pushed") {
      query = query.not("last_pushed_at", "is", null);
    } else if (filterPush === "not_pushed") {
      query = query.is("last_pushed_at", null);
    }
    return query;
  };

  const { data: totalCount } = useQuery({
    queryKey: ["woo-products-count", tenantId, search, filterStatus, filterStock, filterPim, filterPush, filterChanges],
    queryFn: async () => {
      let query = supabase
        .from("woo_products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      query = applyFilters(query);

      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!tenantId,
  });

  const { data: wooProducts, isLoading, refetch } = useQuery({
    queryKey: ["woo-products", tenantId, search, filterStatus, filterStock, filterPim, filterPush, filterChanges, sortBy, sortAsc, page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from("woo_products")
        .select("*")
        .eq("tenant_id", tenantId)
        .order(sortBy, { ascending: sortAsc, nullsFirst: false })
        .range(from, to);

      query = applyFilters(query);

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
  });

  // Client-side filter for changes (since it's JSONB)
  const filteredProducts = wooProducts?.filter((wp: any) => {
    if (filterChanges === "all") return true;
    const pushData = wp.last_push_changes as any;
    if (filterChanges === "has_changes") return pushData?.action === "updated" || pushData?.action === "created";
    if (filterChanges === "no_changes") return !pushData || pushData?.action === "checked";
    return true;
  });

  const handleFetchAll = async () => {
    setFetching(true);
    try {
      const data = await invokeEdgeFunction<{ fetched: number }>("fetch-woo-product-list", { body: { tenantId }, maxRetries: 2 });
      toast.success(`${data.fetched} producten opgehaald uit WooCommerce`);
      refetch();
    } catch (e: any) { toast.error(`Fout bij ophalen: ${e.message}`); }
    finally { setFetching(false); }
  };

  const handlePushProduct = async (wooProduct: any) => {
    if (!wooProduct.product_id) { toast.error("Dit product is niet gekoppeld aan een PIM product"); return; }
    setPushingId(wooProduct.id);
    try {
      const data = await invokeEdgeFunction<{ results: any[] }>("push-to-woocommerce", {
        body: { tenantId, productIds: [wooProduct.product_id] },
        maxRetries: 2,
      });
      const result = data.results?.[0];
      if (result?.action === "updated") {
        toast.success(`${result.sku}: ${result.changes.length} velden bijgewerkt`);
      } else if (result?.action === "created") {
        toast.success(`${result.sku}: nieuw product aangemaakt in WooCommerce`);
      } else if (result?.action === "skipped") {
        toast.info(`${result.sku}: geen wijzigingen gedetecteerd`);
      } else {
        toast.error(`${result?.sku}: ${result?.message}`);
      }
      refetch();
    } catch (e: any) { toast.error(`Fout: ${e.message}`); }
    finally { setPushingId(null); }
  };

  const handlePushAllLinked = async () => {
    const linked = wooProducts?.filter((wp: any) => wp.product_id) || [];
    if (linked.length === 0) { toast.info("Geen gekoppelde producten om te pushen"); return; }
    setPushingAll(true);
    try {
      const productIds = linked.map((wp: any) => wp.product_id);
      const batchSize = 10;
      let totalCreated = 0, totalUpdated = 0, totalSkipped = 0, totalErrors = 0;

      for (let i = 0; i < productIds.length; i += batchSize) {
        const batch = productIds.slice(i, i + batchSize);
        const data = await invokeEdgeFunction<{ totals: any }>("push-to-woocommerce", {
          body: { tenantId, productIds: batch },
          maxRetries: 1,
        }).catch(() => null);
        if (!data) { totalErrors += batch.length; continue; }
        totalCreated += data.totals?.created || 0;
        totalUpdated += data.totals?.updated || 0;
        totalSkipped += data.totals?.skipped || 0;
        totalErrors += data.totals?.errors || 0;
      }

      toast.success(`Push klaar: ${totalCreated} aangemaakt, ${totalUpdated} bijgewerkt, ${totalSkipped} ongewijzigd, ${totalErrors} fouten`);
      refetch();
    } catch (e: any) { toast.error(`Fout: ${e.message}`); }
    finally { setPushingAll(false); }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const statusBadge = (status: string) => {
    const variant = status === "publish" ? "default" : status === "draft" ? "secondary" : "outline";
    return <Badge variant={variant}>{status}</Badge>;
  };

  const stockBadge = (stockStatus: string) => (
    <Badge variant={stockStatus === "instock" ? "default" : "destructive"}>
      {stockStatus === "instock" ? "Op voorraad" : "Uitverkocht"}
    </Badge>
  );

  const linkedCount = wooProducts?.filter((wp: any) => wp.product_id).length || 0;

  const toggleSort = (col: string) => {
    if (sortBy === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(col);
      setSortAsc(col === "name" || col === "sku");
    }
    resetPage();
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortBy !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    return sortAsc ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  const activeFilterCount = [filterStatus, filterStock, filterPim, filterPush, filterChanges].filter(f => f !== "all").length;

  const clearAllFilters = () => {
    setFilterStatus("all");
    setFilterStock("all");
    setFilterPim("all");
    setFilterPush("all");
    setFilterChanges("all");
    setSearch("");
    resetPage();
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Zoek op SKU of naam..." value={search} onChange={(e) => { setSearch(e.target.value); resetPage(); }} className="pl-9" />
        </div>
        <Button variant="outline" size="sm" disabled={fetching} onClick={handleFetchAll}>
          {fetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {fetching ? "Ophalen..." : "Ophalen uit WC"}
        </Button>
        {linkedCount > 0 && (
          <Button variant="default" size="sm" disabled={pushingAll} onClick={handlePushAllLinked}>
            {pushingAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            {pushingAll ? "Pushen..." : `Push ${linkedCount} gekoppelde`}
          </Button>
        )}
        {activeFilterCount > 0 && (
          <Button variant="ghost" size="sm" onClick={clearAllFilters} className="text-muted-foreground">
            <XCircle className="mr-1.5 h-3.5 w-3.5" />
            {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""} wissen
          </Button>
        )}
      </div>

      {/* Column Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); resetPage(); }}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle statussen</SelectItem>
            <SelectItem value="publish">Publish</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="private">Private</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterStock} onValueChange={(v) => { setFilterStock(v); resetPage(); }}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="Voorraad" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle voorraad</SelectItem>
            <SelectItem value="instock">Op voorraad</SelectItem>
            <SelectItem value="outofstock">Uitverkocht</SelectItem>
            <SelectItem value="has_stock">Voorraad &gt; 0</SelectItem>
            <SelectItem value="no_stock">Voorraad = 0</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterPim} onValueChange={(v) => { setFilterPim(v); resetPage(); }}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="PIM koppeling" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle koppelingen</SelectItem>
            <SelectItem value="synced">Gekoppeld</SelectItem>
            <SelectItem value="unsynced">Niet gekoppeld</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterPush} onValueChange={(v) => { setFilterPush(v); resetPage(); }}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="Laatste push" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle pushes</SelectItem>
            <SelectItem value="pushed">Gepusht</SelectItem>
            <SelectItem value="not_pushed">Nooit gepusht</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterChanges} onValueChange={(v) => { setFilterChanges(v); resetPage(); }}>
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <SelectValue placeholder="Wijzigingen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle wijzigingen</SelectItem>
            <SelectItem value="has_changes">Met wijzigingen</SelectItem>
            <SelectItem value="no_changes">Geen wijzigingen</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !filteredProducts || filteredProducts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Geen WooCommerce producten gevonden.</p>
          {activeFilterCount > 0 ? (
            <Button variant="link" size="sm" onClick={clearAllFilters} className="mt-1">Filters wissen</Button>
          ) : (
            <p className="text-sm mt-1">Klik op "Ophalen uit WC" om te starten.</p>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {totalCount != null ? `${totalCount} producten totaal` : `${filteredProducts.length} producten`}
            {totalCount != null && totalCount > PAGE_SIZE && ` — pagina ${page + 1} van ${Math.ceil(totalCount / PAGE_SIZE)}`}
          </p>
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]">Img</TableHead>
                  <TableHead className="w-[110px] cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("sku")}>
                    <span className="inline-flex items-center">SKU<SortIcon col="sku" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("name")}>
                    <span className="inline-flex items-center">Naam<SortIcon col="name" /></span>
                  </TableHead>
                  <TableHead className="w-[80px] cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("status")}>
                    <span className="inline-flex items-center">Status<SortIcon col="status" /></span>
                  </TableHead>
                  <TableHead className="w-[100px] cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("stock_quantity")}>
                    <span className="inline-flex items-center">Voorraad<SortIcon col="stock_quantity" /></span>
                  </TableHead>
                  <TableHead className="w-[90px] cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("regular_price")}>
                    <span className="inline-flex items-center">Prijs<SortIcon col="regular_price" /></span>
                  </TableHead>
                  <TableHead className="w-[90px]">PIM</TableHead>
                  <TableHead className="w-[120px] cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("last_pushed_at")}>
                    <span className="inline-flex items-center">Laatste push<SortIcon col="last_pushed_at" /></span>
                  </TableHead>
                  <TableHead className="w-[180px]">Wijzigingen</TableHead>
                  <TableHead className="w-[50px]">Push</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.map((wp: any) => {
                  const firstImage = Array.isArray(wp.images) && wp.images.length > 0 ? wp.images[0] : null;
                  const pushData = wp.last_push_changes as any;
                  const hasRecentPush = pushData?.action === "updated" || pushData?.action === "created";

                  return (
                    <TableRow key={wp.id} className={hasRecentPush ? "bg-primary/[0.02]" : ""}>
                      <TableCell className="p-2">
                        {firstImage?.src ? (
                          <img src={firstImage.src} alt={firstImage.alt || wp.name} className="w-9 h-9 object-cover rounded" />
                        ) : (
                          <div className="w-9 h-9 bg-muted rounded flex items-center justify-center">
                            <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{wp.sku || "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm truncate max-w-[180px]">{wp.name}</span>
                          {wp.permalink && (
                            <a href={wp.permalink} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary shrink-0">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground">WC #{wp.woo_id}</span>
                      </TableCell>
                      <TableCell>{statusBadge(wp.status)}</TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          {stockBadge(wp.stock_status)}
                          {wp.stock_quantity != null && (
                            <span className="block text-[10px] text-muted-foreground">{wp.stock_quantity} stuks</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {wp.regular_price ? `€${wp.regular_price}` : "—"}
                          {wp.sale_price && <span className="block text-[10px] text-destructive">Sale: €{wp.sale_price}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        {wp.product_id ? (
                          <Badge variant="outline" className="text-[10px] bg-success/10 text-success border-success/30">Gekoppeld</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">Niet gekoppeld</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDate(wp.last_pushed_at)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ChangeBadges pushData={pushData} />
                      </TableCell>
                      <TableCell className="p-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={!wp.product_id || pushingId === wp.id}
                          onClick={() => handlePushProduct(wp)}
                          title="Push naar WooCommerce"
                        >
                          {pushingId === wp.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {/* Pagination */}
          {totalCount != null && totalCount > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-3">
              <p className="text-xs text-muted-foreground">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} van {totalCount}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  Vorige
                </Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= totalCount} onClick={() => setPage(p => p + 1)}>
                  Volgende
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
