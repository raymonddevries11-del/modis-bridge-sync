import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
} from "lucide-react";
import { toast } from "sonner";

interface WooProductTableProps {
  tenantId: string;
}

type SyncFilter = "all" | "synced" | "unsynced" | "recently_pushed";

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
  const pushedAt = pushData.pushed_at;

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
  const [syncFilter, setSyncFilter] = useState<SyncFilter>("all");
  const [sortBy, setSortBy] = useState<"last_fetched_at" | "last_pushed_at" | "name">("last_fetched_at");
  const [fetching, setFetching] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushingAll, setPushingAll] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Reset page when filters change
  const resetPage = () => setPage(0);

  // Get total count
  const { data: totalCount } = useQuery({
    queryKey: ["woo-products-count", tenantId, search, syncFilter],
    queryFn: async () => {
      let query = supabase
        .from("woo_products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      if (search) {
        query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%`);
      }
      if (syncFilter === "synced") query = query.not("product_id", "is", null);
      else if (syncFilter === "unsynced") query = query.is("product_id", null);
      else if (syncFilter === "recently_pushed") query = query.not("last_pushed_at", "is", null);

      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!tenantId,
  });

  const { data: wooProducts, isLoading, refetch } = useQuery({
    queryKey: ["woo-products", tenantId, search, syncFilter, sortBy, page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from("woo_products")
        .select("*")
        .eq("tenant_id", tenantId)
        .order(sortBy, { ascending: false, nullsFirst: false })
        .range(from, to);

      if (search) {
        query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%`);
      }
      if (syncFilter === "synced") query = query.not("product_id", "is", null);
      else if (syncFilter === "unsynced") query = query.is("product_id", null);
      else if (syncFilter === "recently_pushed") query = query.not("last_pushed_at", "is", null);

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
  });

  const handleFetchAll = async () => {
    setFetching(true);
    try {
      const { data, error } = await supabase.functions.invoke("fetch-woo-product-list", { body: { tenantId } });
      if (error) throw error;
      toast.success(`${data.fetched} producten opgehaald uit WooCommerce`);
      refetch();
    } catch (e: any) { toast.error(`Fout bij ophalen: ${e.message}`); }
    finally { setFetching(false); }
  };

  const handlePushProduct = async (wooProduct: any) => {
    if (!wooProduct.product_id) { toast.error("Dit product is niet gekoppeld aan een PIM product"); return; }
    setPushingId(wooProduct.id);
    try {
      const { data, error } = await supabase.functions.invoke("push-to-woocommerce", {
        body: { tenantId, productIds: [wooProduct.product_id] },
      });
      if (error) throw error;

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
      // Push in batches of 10
      const batchSize = 10;
      let totalCreated = 0, totalUpdated = 0, totalSkipped = 0, totalErrors = 0;

      for (let i = 0; i < productIds.length; i += batchSize) {
        const batch = productIds.slice(i, i + batchSize);
        const { data, error } = await supabase.functions.invoke("push-to-woocommerce", {
          body: { tenantId, productIds: batch },
        });
        if (error) { totalErrors += batch.length; continue; }
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

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Zoek op SKU of naam..." value={search} onChange={(e) => { setSearch(e.target.value); resetPage(); }} className="pl-9" />
        </div>
        <Select value={syncFilter} onValueChange={(v) => { setSyncFilter(v as SyncFilter); resetPage(); }}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Filter" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle producten</SelectItem>
            <SelectItem value="synced">Gekoppeld aan PIM</SelectItem>
            <SelectItem value="unsynced">Niet gekoppeld</SelectItem>
            <SelectItem value="recently_pushed">Recent gepusht</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Sorteren" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="last_fetched_at">Laatst opgehaald</SelectItem>
            <SelectItem value="last_pushed_at">Laatst gepusht</SelectItem>
            <SelectItem value="name">Naam</SelectItem>
          </SelectContent>
        </Select>
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
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !wooProducts || wooProducts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Geen WooCommerce producten gevonden.</p>
          <p className="text-sm mt-1">Klik op "Ophalen uit WC" om te starten.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {totalCount != null ? `${totalCount} producten totaal` : `${wooProducts.length} producten`}
            {totalCount != null && totalCount > PAGE_SIZE && ` — pagina ${page + 1} van ${Math.ceil(totalCount / PAGE_SIZE)}`}
          </p>
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]">Img</TableHead>
                  <TableHead className="w-[110px]">SKU</TableHead>
                  <TableHead>Naam</TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                  <TableHead className="w-[100px]">Voorraad</TableHead>
                  <TableHead className="w-[90px]">Prijs</TableHead>
                  <TableHead className="w-[90px]">PIM</TableHead>
                  <TableHead className="w-[120px]">Laatste push</TableHead>
                  <TableHead className="w-[180px]">Wijzigingen</TableHead>
                  <TableHead className="w-[50px]">Push</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wooProducts.map((wp: any) => {
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
