import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertTriangle, RefreshCw, Loader2, CheckCircle2, Clock, XCircle, ShieldAlert, Info,
} from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";

interface FailedPushPanelProps {
  tenantId: string;
}

interface FailedProduct {
  id: string;
  woo_id: number;
  sku: string | null;
  name: string;
  product_id: string | null;
  last_pushed_at: string | null;
  last_push_changes: any;
}

export const FailedPushPanel = ({ tenantId }: FailedPushPanelProps) => {
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [retryingAll, setRetryingAll] = useState(false);
  const queryClient = useQueryClient();

  const { data: failedProducts, isLoading } = useQuery({
    queryKey: ["woo-failed-pushes", tenantId],
    queryFn: async () => {
      // Get products where last_push_changes contains error info
      const { data, error } = await supabase
        .from("woo_products")
        .select("id, woo_id, sku, name, product_id, last_pushed_at, last_push_changes")
        .eq("tenant_id", tenantId)
        .not("last_push_changes", "is", null)
        .order("last_pushed_at", { ascending: false })
        .limit(200);

      if (error) throw error;

      // Filter to only products with error results or bot-protection blocks
      return (data || []).filter((p: any) => {
        const lpc = p.last_push_changes;
        if (!lpc) return false;
        // Check for error action or bot-protection message
        if (lpc.action === 'error') return true;
        if (typeof lpc.message === 'string' && (
          lpc.message.toLowerCase().includes('error') ||
          lpc.message.toLowerCase().includes('blocked') ||
          lpc.message.toLowerCase().includes('failed') ||
          lpc.message.toLowerCase().includes('bot protection')
        )) return true;
        // Check in fields array for error markers
        if (Array.isArray(lpc.fields)) {
          return lpc.fields.some((f: any) =>
            typeof f.new_value === 'string' && f.new_value.toLowerCase().includes('error')
          );
        }
        return false;
      }) as FailedProduct[];
    },
    enabled: !!tenantId,
    refetchInterval: 15000,
  });

  // Also fetch recent error jobs from the changelog
  const { data: recentErrors } = useQuery({
    queryKey: ["woo-push-errors-changelog", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("changelog")
        .select("id, description, metadata, created_at")
        .eq("tenant_id", tenantId)
        .eq("event_type", "WOO_PRODUCT_PUSH")
        .order("created_at", { ascending: false })
        .limit(10);

      if (error) throw error;
      // Only return entries that had errors
      return (data || []).filter((c: any) => {
        const totals = c.metadata?.totals;
        return totals && totals.errors > 0;
      });
    },
    enabled: !!tenantId,
  });

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["woo-failed-pushes", tenantId] });
    queryClient.invalidateQueries({ queryKey: ["woo-push-errors-changelog", tenantId] });
  };

  const handleRetry = async (product: FailedProduct) => {
    if (!product.product_id) {
      toast.error(`${product.sku || product.name}: niet gekoppeld aan PIM`);
      return;
    }
    setRetryingIds(prev => new Set(prev).add(product.id));
    try {
      const { data, error } = await supabase.functions.invoke("push-to-woocommerce", {
        body: { tenantId, productIds: [product.product_id] },
      });
      if (error) throw error;

      const result = data.results?.[0];
      if (result?.action === "updated") {
        toast.success(`${result.sku}: ${result.changes.length} velden bijgewerkt`);
      } else if (result?.action === "created") {
        toast.success(`${result.sku}: aangemaakt in WooCommerce`);
      } else if (result?.action === "skipped") {
        toast.info(`${result.sku}: geen wijzigingen`);
      } else if (result?.action === "error") {
        toast.error(`${result.sku}: ${result.message}`);
      }
      refetchAll();
    } catch (e: any) {
      toast.error(`Retry mislukt: ${e.message}`);
    } finally {
      setRetryingIds(prev => {
        const next = new Set(prev);
        next.delete(product.id);
        return next;
      });
    }
  };

  const handleRetrySelected = async () => {
    const products = failedProducts?.filter(p => selectedIds.has(p.id) && p.product_id) || [];
    if (products.length === 0) {
      toast.error("Geen retrybare producten geselecteerd");
      return;
    }
    setRetryingAll(true);
    try {
      const productIds = products.map(p => p.product_id!);
      const batchSize = 10;
      let totalOk = 0, totalErr = 0;

      for (let i = 0; i < productIds.length; i += batchSize) {
        const batch = productIds.slice(i, i + batchSize);
        const { data, error } = await supabase.functions.invoke("push-to-woocommerce", {
          body: { tenantId, productIds: batch },
        });
        if (error) { totalErr += batch.length; continue; }
        totalOk += (data.totals?.created || 0) + (data.totals?.updated || 0) + (data.totals?.skipped || 0);
        totalErr += data.totals?.errors || 0;
      }

      toast.success(`Retry klaar: ${totalOk} gelukt, ${totalErr} fouten`);
      setSelectedIds(new Set());
      refetchAll();
    } catch (e: any) {
      toast.error(`Retry mislukt: ${e.message}`);
    } finally {
      setRetryingAll(false);
    }
  };

  const handleRetryAll = async () => {
    const retryable = failedProducts?.filter(p => p.product_id) || [];
    if (retryable.length === 0) {
      toast.info("Geen retrybare producten gevonden");
      return;
    }
    setRetryingAll(true);
    try {
      const productIds = retryable.map(p => p.product_id!);
      const batchSize = 10;
      let totalOk = 0, totalErr = 0;

      for (let i = 0; i < productIds.length; i += batchSize) {
        const batch = productIds.slice(i, i + batchSize);
        const { data, error } = await supabase.functions.invoke("push-to-woocommerce", {
          body: { tenantId, productIds: batch },
        });
        if (error) { totalErr += batch.length; continue; }
        totalOk += (data.totals?.created || 0) + (data.totals?.updated || 0) + (data.totals?.skipped || 0);
        totalErr += data.totals?.errors || 0;
      }

      toast.success(`Retry klaar: ${totalOk} gelukt, ${totalErr} fouten`);
      refetchAll();
    } catch (e: any) {
      toast.error(`Retry mislukt: ${e.message}`);
    } finally {
      setRetryingAll(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!failedProducts) return;
    if (selectedIds.size === failedProducts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(failedProducts.map(p => p.id)));
    }
  };

  const getErrorMessage = (lpc: any): string => {
    if (!lpc) return "Onbekende fout";
    if (lpc.message) return lpc.message;
    if (lpc.action === 'error') return "Push mislukt";
    if (Array.isArray(lpc.fields)) {
      const errField = lpc.fields.find((f: any) => f.new_value?.toLowerCase?.().includes('error'));
      if (errField) return errField.new_value;
    }
    return "Onbekende fout";
  };

  const getErrorType = (msg: string): { icon: any; label: string; color: string } => {
    const lower = msg.toLowerCase();
    if (lower.includes('bot protection') || lower.includes('blocked') || lower.includes('html')) {
      return { icon: ShieldAlert, label: "Bot Protection", color: "bg-amber-500/15 text-amber-700 border-amber-500/30" };
    }
    if (lower.includes('400') || lower.includes('invalid')) {
      return { icon: XCircle, label: "Validatiefout", color: "bg-red-500/15 text-red-700 border-red-500/30" };
    }
    if (lower.includes('timeout') || lower.includes('fetch')) {
      return { icon: Clock, label: "Timeout", color: "bg-orange-500/15 text-orange-700 border-orange-500/30" };
    }
    return { icon: AlertTriangle, label: "Fout", color: "bg-destructive/15 text-destructive border-destructive/30" };
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString("nl-NL", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!failedProducts || failedProducts.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-success opacity-70" />
        <p className="font-medium">Geen mislukte pushes</p>
        <p className="text-sm mt-1">Alle recente pushes zijn succesvol verlopen.</p>
      </div>
    );
  }

  const retryableCount = failedProducts.filter(p => p.product_id).length;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Recent error summary from changelog */}
        {recentErrors && recentErrors.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <span className="text-sm font-medium text-amber-700">Recente push fouten</span>
            </div>
            <div className="space-y-1">
              {recentErrors.slice(0, 3).map((c: any) => (
                <div key={c.id} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{c.description}</span>
                  <span className="text-muted-foreground">{formatDate(c.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="destructive" className="text-xs">
              {failedProducts.length} mislukt
            </Badge>
            {retryableCount < failedProducts.length && (
              <Badge variant="secondary" className="text-xs">
                {failedProducts.length - retryableCount} niet retrybaar (geen PIM koppeling)
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 && (
              <Button size="sm" variant="outline" disabled={retryingAll} onClick={handleRetrySelected}>
                {retryingAll ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Retry {selectedIds.size} geselecteerd
              </Button>
            )}
            {retryableCount > 0 && (
              <Button size="sm" disabled={retryingAll} onClick={handleRetryAll}>
                {retryingAll ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Retry alle {retryableCount}
              </Button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]">
                  <Checkbox
                    checked={failedProducts.length > 0 && selectedIds.size === failedProducts.length}
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Fouttype</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Laatste poging</TableHead>
                <TableHead className="w-[60px]">Retry</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failedProducts.map((p) => {
                const msg = getErrorMessage(p.last_push_changes);
                const errType = getErrorType(msg);
                const ErrIcon = errType.icon;
                const isRetrying = retryingIds.has(p.id);

                return (
                  <TableRow key={p.id} className={selectedIds.has(p.id) ? "bg-primary/[0.03]" : ""}>
                    <TableCell className="p-2">
                      <Checkbox
                        checked={selectedIds.has(p.id)}
                        onCheckedChange={() => toggleSelect(p.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.sku || "—"}</TableCell>
                    <TableCell>
                      <span className="text-sm truncate block max-w-[160px]">{p.name}</span>
                      <span className="text-[10px] text-muted-foreground">WC #{p.woo_id}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${errType.color}`}>
                        <ErrIcon className="h-3 w-3 mr-1" />
                        {errType.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-muted-foreground truncate block max-w-[220px] cursor-help">
                            {msg.length > 60 ? msg.substring(0, 60) + "…" : msg}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs whitespace-pre-wrap">{msg}</p>
                          {p.last_push_changes?.pushed_at && (
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Push: {formatDate(p.last_push_changes.pushed_at)}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      {p.last_pushed_at ? (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDate(p.last_pushed_at)}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="p-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={!p.product_id || isRetrying}
                        onClick={() => handleRetry(p)}
                        title={p.product_id ? "Opnieuw pushen" : "Niet gekoppeld aan PIM"}
                      >
                        {isRetrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* Info box */}
        <div className="flex items-start gap-2 rounded-lg border p-3 bg-muted/30">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p><strong>Bot Protection</strong> fouten worden veroorzaakt door SiteGround's beveiliging. De push functie probeert automatisch opnieuw met exponentiële backoff.</p>
            <p><strong>Validatiefouten</strong> (400) worden vaak veroorzaakt door ongeldige data, zoals prijzen op variable producten of ongeldige afbeeldings-URLs.</p>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};
