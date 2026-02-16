import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Search, ChevronDown, ChevronRight, RefreshCw, Loader2, ChevronLeft, ChevronsLeft, ChevronsRight } from "lucide-react";
import { TenantSelector } from "@/components/TenantSelector";

interface WooAttribute {
  id: number;
  name: string;
  slug: string;
  type: string;
  termCount: number;
  terms: { id: number; name: string; slug: string; count: number }[];
}

const PAGE_SIZE = 10;

export function WooAttributeCatalog() {
  const [tenantId, setTenantId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [openAttrs, setOpenAttrs] = useState<Set<number>>(new Set());

  const { data: wooAttrs, isLoading, refetch } = useQuery({
    queryKey: ["woo-attributes-catalog", tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("fetch-woo-attributes", {
        body: { tenantId },
      });
      if (error) throw error;
      return (data?.attributes ?? []) as WooAttribute[];
    },
  });

  const filtered = useMemo(() => {
    if (!wooAttrs) return [];
    if (!search.trim()) return wooAttrs;
    const q = search.toLowerCase();
    return wooAttrs.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.slug.toLowerCase().includes(q) ||
        a.terms.some((t) => t.name.toLowerCase().includes(q))
    );
  }, [wooAttrs, search]);

  // Reset page on search change
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(0, totalPages - 1));
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const toggleAttr = (id: number) => {
    setOpenAttrs((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const totalTerms = wooAttrs?.reduce((sum, a) => sum + a.termCount, 0) ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">WooCommerce Attributen Catalogus</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <TenantSelector value={tenantId} onChange={setTenantId} />
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Zoek attribuut of term..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading || !tenantId}
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {wooAttrs && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{wooAttrs.length} attributen</Badge>
            <Badge variant="outline">{totalTerms} termen totaal</Badge>
            {search && (
              <Badge variant="secondary" className="text-[10px]">
                {filtered.length} resultaten
              </Badge>
            )}
          </div>
        )}

        {!tenantId ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Selecteer een tenant
          </p>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">WC attributen laden...</span>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Geen attributen gevonden</p>
        ) : (
          <>
            <div className="space-y-1">
              {pageItems.map((attr) => {
                const isOpen = openAttrs.has(attr.id);
                return (
                  <Collapsible key={attr.id} open={isOpen} onOpenChange={() => toggleAttr(attr.id)}>
                    <CollapsibleTrigger className="flex items-center gap-3 w-full px-4 py-2.5 bg-card border border-border rounded-lg hover:bg-muted/50 transition-colors text-left">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-sm font-medium flex-1">{attr.name}</span>
                      <Badge variant="secondary" className="text-[10px]">{attr.slug}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{attr.termCount} termen</Badge>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-7 mt-1 mb-2 px-4 py-3 bg-muted/30 rounded-lg border border-border/50">
                        {attr.terms.length === 0 ? (
                          <span className="text-xs text-muted-foreground">Geen termen</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {attr.terms.map((t) => (
                              <Badge key={t.id} variant="outline" className="text-xs font-normal">
                                {t.name}
                                <span className="ml-1 text-[10px] opacity-60">({t.count})</span>
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-muted-foreground">
                  {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} van {filtered.length}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={currentPage === 0} onClick={() => setPage(0)}>
                    <ChevronsLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs px-2">{currentPage + 1} / {totalPages}</span>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={currentPage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>
                    <ChevronsRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
