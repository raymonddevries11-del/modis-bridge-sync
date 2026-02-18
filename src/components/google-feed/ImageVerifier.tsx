import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ScanSearch,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Loader2,
  FileWarning,
  Wrench,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "react-router-dom";

interface UrlResult {
  url: string;
  status: "ok" | "missing" | "case_mismatch" | "external";
  storagePath?: string;
  suggestion?: string;
}

interface ProductResult {
  id: string;
  sku: string;
  title: string;
  urls: UrlResult[];
  summary: { ok: number; missing: number; case_mismatch: number; external: number };
}

interface VerifyResponse {
  storageFilesIndexed: number;
  productsScanned: number;
  totals: { ok: number; missing: number; case_mismatch: number; external: number };
  products: ProductResult[];
}

const STATUS_CONFIG = {
  ok: { icon: CheckCircle2, label: "OK", className: "text-emerald-600" },
  missing: { icon: XCircle, label: "Ontbreekt", className: "text-destructive" },
  case_mismatch: { icon: FileWarning, label: "Case mismatch", className: "text-amber-500" },
  external: { icon: ExternalLink, label: "Extern", className: "text-muted-foreground" },
} as const;

export function ImageVerifier() {
  const { toast } = useToast();
  const [isVerifying, setIsVerifying] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [verifyFilter, setVerifyFilter] = useState<"all" | "missing" | "case_mismatch" | "external">("all");
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  const runVerification = async (filterOverride?: string) => {
    setIsVerifying(true);
    setResult(null);
    setPage(0);
    try {
      const { data, error } = await supabase.functions.invoke("verify-image-urls", {
        body: {
          tenant: "kosterschoenmode",
          limit: 500,
          offset: 0,
          filterStatus: filterOverride === "all" ? undefined : filterOverride,
        },
      });
      if (error) throw error;
      setResult(data as VerifyResponse);
    } catch (err) {
      console.error("Verify error:", err);
    } finally {
      setIsVerifying(false);
    }
  };

  const runRepair = async () => {
    setIsRepairing(true);
    try {
      const { data, error } = await supabase.functions.invoke("reconcile-images", {
        body: { tenant: "kosterschoenmode", dryRun: false },
      });
      if (error) throw error;
      toast({
        title: "Repair voltooid",
        description: `${data?.productsFixed || 0} producten bijgewerkt, ${data?.urlsFixed || 0} URLs gefixt`,
      });
      // Re-run verification to show updated state
      await runVerification(verifyFilter);
    } catch (err) {
      toast({
        title: "Repair mislukt",
        description: err instanceof Error ? err.message : "Onbekende fout",
        variant: "destructive",
      });
    } finally {
      setIsRepairing(false);
    }
  };

  const filteredProducts = result?.products.filter((p) => {
    if (verifyFilter === "all") return true;
    return p.urls.some((u) => u.status === verifyFilter);
  }) ?? [];

  const paginatedProducts = filteredProducts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filteredProducts.length / PAGE_SIZE);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <ScanSearch className="h-4 w-4 text-primary" />
            Image Existence Verifier
          </CardTitle>
          <div className="flex gap-2">
            {result && (result.totals.case_mismatch > 0 || result.totals.missing > 0) && (
              <Button
                onClick={runRepair}
                disabled={isRepairing || isVerifying}
                size="sm"
                variant="default"
              >
                {isRepairing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Wrench className="h-4 w-4 mr-2" />
                )}
                {isRepairing ? "Repairing…" : `Repair ${result.totals.case_mismatch + result.totals.missing} issues`}
              </Button>
            )}
            <Button
              onClick={() => runVerification(verifyFilter)}
              disabled={isVerifying || isRepairing}
              size="sm"
              variant="outline"
            >
              {isVerifying ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <ScanSearch className="h-4 w-4 mr-2" />
              )}
              {isVerifying ? "Verifiëren…" : "Verify nu"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Controleert elke DB image URL tegen de storage bucket en rapporteert ontbrekende of mismatched bestanden
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Totals bar */}
        {result && (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-muted-foreground">
              {result.storageFilesIndexed} bestanden geïndexeerd · {result.productsScanned} producten gescand
            </span>
            <div className="flex gap-1.5 ml-auto">
              {([
                { key: "all" as const, label: "Alle", count: result.products.length },
                { key: "missing" as const, label: "Ontbreekt", count: result.totals.missing, variant: "destructive" as const },
                { key: "case_mismatch" as const, label: "Case", count: result.totals.case_mismatch, variant: "secondary" as const },
                { key: "external" as const, label: "Extern", count: result.totals.external, variant: "outline" as const },
              ]).map((f) => (
                <Button
                  key={f.key}
                  variant={verifyFilter === f.key ? "default" : "outline"}
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => { setVerifyFilter(f.key); setPage(0); }}
                >
                  {f.label}
                  <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">
                    {f.count}
                  </Badge>
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Results table */}
        {result && filteredProducts.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead className="w-[120px]">SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="w-[70px] text-center">
                    <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-emerald-600" />
                  </TableHead>
                  <TableHead className="w-[70px] text-center">
                    <XCircle className="h-3.5 w-3.5 mx-auto text-destructive" />
                  </TableHead>
                  <TableHead className="w-[70px] text-center">
                    <FileWarning className="h-3.5 w-3.5 mx-auto text-amber-500" />
                  </TableHead>
                  <TableHead className="w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedProducts.map((p) => {
                  const isExpanded = expandedProduct === p.id;
                  return (
                    <Collapsible key={p.id} open={isExpanded} onOpenChange={() => setExpandedProduct(isExpanded ? null : p.id)} asChild>
                      <>
                        <CollapsibleTrigger asChild>
                          <TableRow className="cursor-pointer hover:bg-muted/50">
                            <TableCell className="pr-0">
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                            <TableCell className="text-sm truncate max-w-[250px]">{p.title}</TableCell>
                            <TableCell className="text-center text-sm font-medium text-emerald-600">
                              {p.summary.ok || "—"}
                            </TableCell>
                            <TableCell className="text-center text-sm font-medium text-destructive">
                              {p.summary.missing || "—"}
                            </TableCell>
                            <TableCell className="text-center text-sm font-medium text-amber-500">
                              {p.summary.case_mismatch || "—"}
                            </TableCell>
                            <TableCell>
                              <Link to={`/products/${p.id}`} onClick={(e) => e.stopPropagation()}>
                                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                              </Link>
                            </TableCell>
                          </TableRow>
                        </CollapsibleTrigger>
                        <CollapsibleContent asChild>
                          <TableRow>
                            <TableCell colSpan={7} className="bg-muted/30 p-0">
                              <div className="px-6 py-3 space-y-1.5">
                                {p.urls.map((u, i) => {
                                  const cfg = STATUS_CONFIG[u.status];
                                  const Icon = cfg.icon;
                                  const filename = u.url.split("/").pop()?.split("?")[0] || u.url;
                                  return (
                                    <div key={i} className="flex items-center gap-2 text-xs">
                                      <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${cfg.className}`} />
                                      <span className="font-mono truncate max-w-[400px]" title={u.url}>
                                        {filename}
                                      </span>
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                        {cfg.label}
                                      </Badge>
                                      {u.suggestion && (
                                        <span className="text-muted-foreground">
                                          → <span className="font-mono">{u.suggestion}</span>
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
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

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-muted-foreground">
                  Pagina {page + 1} van {totalPages} ({filteredProducts.length} producten)
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="outline" size="sm" className="h-7 text-xs"
                    disabled={page === 0}
                    onClick={() => setPage(p => p - 1)}
                  >
                    Vorige
                  </Button>
                  <Button
                    variant="outline" size="sm" className="h-7 text-xs"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(p => p + 1)}
                  >
                    Volgende
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {result && filteredProducts.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-600" />
            Alle image URLs zijn correct gekoppeld aan storage bestanden
          </div>
        )}

        {!result && !isVerifying && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            Klik "Verify nu" om alle image URLs te controleren tegen de storage bucket
          </div>
        )}
      </CardContent>
    </Card>
  );
}
