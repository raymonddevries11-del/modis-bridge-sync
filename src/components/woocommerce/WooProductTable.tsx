import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  Loader2,
  ExternalLink,
  Search,
  Image as ImageIcon,
  Send,
} from "lucide-react";
import { toast } from "sonner";

interface WooProductTableProps {
  tenantId: string;
}

type SyncFilter = "all" | "synced" | "unsynced" | "recently_pushed";

export const WooProductTable = ({ tenantId }: WooProductTableProps) => {
  const [search, setSearch] = useState("");
  const [syncFilter, setSyncFilter] = useState<SyncFilter>("all");
  const [sortBy, setSortBy] = useState<"last_fetched_at" | "last_pushed_at" | "name">("last_fetched_at");
  const [fetching, setFetching] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);

  const { data: wooProducts, isLoading, refetch } = useQuery({
    queryKey: ["woo-products", tenantId, search, syncFilter, sortBy],
    queryFn: async () => {
      let query = supabase
        .from("woo_products")
        .select("*")
        .eq("tenant_id", tenantId)
        .order(sortBy, { ascending: false, nullsFirst: false })
        .limit(200);

      if (search) {
        query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%`);
      }

      if (syncFilter === "synced") {
        query = query.not("product_id", "is", null);
      } else if (syncFilter === "unsynced") {
        query = query.is("product_id", null);
      } else if (syncFilter === "recently_pushed") {
        query = query.not("last_pushed_at", "is", null);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
  });

  const handleFetchAll = async () => {
    setFetching(true);
    try {
      const { data, error } = await supabase.functions.invoke("fetch-woo-product-list", {
        body: { tenantId },
      });
      if (error) throw error;
      toast.success(`${data.fetched} producten opgehaald uit WooCommerce`);
      refetch();
    } catch (e: any) {
      toast.error(`Fout bij ophalen: ${e.message}`);
    } finally {
      setFetching(false);
    }
  };

  const handlePushProduct = async (wooProduct: any) => {
    if (!wooProduct.product_id) {
      toast.error("Dit product is niet gekoppeld aan een PIM product");
      return;
    }
    setPushingId(wooProduct.id);
    try {
      // Create a sync job for this product
      const { error } = await supabase.from("jobs").insert({
        type: "SYNC_TO_WOO",
        state: "ready" as const,
        payload: { productIds: [wooProduct.product_id] },
        tenant_id: tenantId,
      });
      if (error) throw error;

      // Update last_pushed_at
      await supabase
        .from("woo_products")
        .update({
          last_pushed_at: new Date().toISOString(),
          last_push_changes: { type: "full_sync", triggered_at: new Date().toISOString() },
        })
        .eq("id", wooProduct.id);

      toast.success(`Sync job aangemaakt voor ${wooProduct.name}`);
      refetch();
    } catch (e: any) {
      toast.error(`Fout: ${e.message}`);
    } finally {
      setPushingId(null);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString("nl-NL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const statusBadge = (status: string) => {
    const variant = status === "publish" ? "default" : status === "draft" ? "secondary" : "outline";
    return <Badge variant={variant}>{status}</Badge>;
  };

  const stockBadge = (stockStatus: string) => {
    return (
      <Badge variant={stockStatus === "instock" ? "default" : "destructive"}>
        {stockStatus === "instock" ? "Op voorraad" : "Uitverkocht"}
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Zoek op SKU of naam..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={syncFilter} onValueChange={(v) => setSyncFilter(v as SyncFilter)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle producten</SelectItem>
            <SelectItem value="synced">Gekoppeld aan PIM</SelectItem>
            <SelectItem value="unsynced">Niet gekoppeld</SelectItem>
            <SelectItem value="recently_pushed">Recent gepusht</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Sorteren" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last_fetched_at">Laatst opgehaald</SelectItem>
            <SelectItem value="last_pushed_at">Laatst gepusht</SelectItem>
            <SelectItem value="name">Naam</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={fetching}
          onClick={handleFetchAll}
        >
          {fetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {fetching ? "Ophalen..." : "Ophalen uit WooCommerce"}
        </Button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !wooProducts || wooProducts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Geen WooCommerce producten gevonden.</p>
          <p className="text-sm mt-1">Klik op "Ophalen uit WooCommerce" om te starten.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{wooProducts.length} producten</p>
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">Img</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Naam</TableHead>
                  <TableHead>WC Status</TableHead>
                  <TableHead>Voorraad</TableHead>
                  <TableHead>Prijs</TableHead>
                  <TableHead>PIM</TableHead>
                  <TableHead>Laatste push</TableHead>
                  <TableHead>Wijzigingen</TableHead>
                  <TableHead className="w-[100px]">Acties</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wooProducts.map((wp: any) => {
                  const firstImage = Array.isArray(wp.images) && wp.images.length > 0 ? wp.images[0] : null;
                  const pushChanges = wp.last_push_changes as any;

                  return (
                    <TableRow key={wp.id}>
                      <TableCell>
                        {firstImage?.src ? (
                          <img
                            src={firstImage.src}
                            alt={firstImage.alt || wp.name}
                            className="w-10 h-10 object-cover rounded"
                          />
                        ) : (
                          <div className="w-10 h-10 bg-muted rounded flex items-center justify-center">
                            <ImageIcon className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{wp.sku || "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm truncate max-w-[200px]">{wp.name}</span>
                          {wp.permalink && (
                            <a
                              href={wp.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-primary"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">WC #{wp.woo_id}</span>
                      </TableCell>
                      <TableCell>{statusBadge(wp.status)}</TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          {stockBadge(wp.stock_status)}
                          {wp.stock_quantity != null && (
                            <span className="block text-xs text-muted-foreground">{wp.stock_quantity} stuks</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {wp.regular_price ? `€${wp.regular_price}` : "—"}
                          {wp.sale_price && (
                            <span className="block text-xs text-destructive">Sale: €{wp.sale_price}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {wp.product_id ? (
                          <Badge variant="outline" className="text-xs bg-primary/5">Gekoppeld</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Niet gekoppeld</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(wp.last_pushed_at)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {pushChanges?.type || "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={!wp.product_id || pushingId === wp.id}
                          onClick={() => handlePushProduct(wp)}
                          title="Push naar WooCommerce"
                        >
                          {pushingId === wp.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
};
