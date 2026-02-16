import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RefreshCw, Loader2, Search, ChevronDown, ChevronRight, Check, Link2, Unlink } from "lucide-react";
import { TenantSelector } from "@/components/TenantSelector";

interface WooAttribute {
  id: number;
  name: string;
  slug: string;
  type: string;
  termCount: number;
  terms: { id: number; name: string; slug: string; count: number }[];
}

interface ModisAttribute {
  name: string;
  values: string[];
  count: number;
}

export function WooAttributeSync() {
  const [tenantId, setTenantId] = useState("");
  const [search, setSearch] = useState("");
  const [openAttrs, setOpenAttrs] = useState<Set<string>>(new Set());

  // Fetch WooCommerce attributes
  const { data: wooAttrs, isLoading: wooLoading, refetch: refetchWoo } = useQuery({
    queryKey: ["woo-attributes", tenantId],
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

  // Fetch Modis attributes from products
  const { data: modisAttrs, isLoading: modisLoading } = useQuery({
    queryKey: ["modis-attributes-for-sync", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("attributes")
        .eq("tenant_id", tenantId)
        .not("attributes", "is", null)
        .limit(1000);
      if (error) throw error;

      const attrMap = new Map<string, { values: Set<string>; count: number }>();
      for (const row of data ?? []) {
        const attrs = row.attributes as Record<string, string> | null;
        if (!attrs || typeof attrs !== "object") continue;
        for (const [key, val] of Object.entries(attrs)) {
          if (!key || val === undefined || val === null) continue;
          const existing = attrMap.get(key) || { values: new Set<string>(), count: 0 };
          existing.values.add(String(val));
          existing.count++;
          attrMap.set(key, existing);
        }
      }

      return Array.from(attrMap.entries())
        .map(([name, data]) => ({
          name,
          values: Array.from(data.values).sort(),
          count: data.count,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)) as ModisAttribute[];
    },
  });

  const toggleAttr = (key: string) => {
    setOpenAttrs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Build matching: find WC attribute that matches Modis attribute by name/slug
  const getWooMatch = (modisName: string): WooAttribute | null => {
    if (!wooAttrs) return null;
    const lower = modisName.toLowerCase().replace(/\s+/g, "-");
    return (
      wooAttrs.find(
        (wa) =>
          wa.name.toLowerCase() === modisName.toLowerCase() ||
          wa.slug === lower ||
          wa.slug === `pa_${lower}`
      ) || null
    );
  };

  const isLoading = wooLoading || modisLoading;

  const filtered = modisAttrs?.filter(
    (a) => a.name.toLowerCase().includes(search.toLowerCase())
  );

  const matchedCount = modisAttrs?.filter((a) => getWooMatch(a.name) !== null).length ?? 0;
  const unmatchedCount = (modisAttrs?.length ?? 0) - matchedCount;

  // WC attributes not matched to any Modis attribute
  const unmatchedWoo = wooAttrs?.filter((wa) => {
    if (!modisAttrs) return true;
    return !modisAttrs.some((ma) => {
      const lower = ma.name.toLowerCase().replace(/\s+/g, "-");
      return (
        wa.name.toLowerCase() === ma.name.toLowerCase() ||
        wa.slug === lower ||
        wa.slug === `pa_${lower}`
      );
    });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attribuut Mapping: Modis ↔ WooCommerce</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <TenantSelector value={tenantId} onChange={setTenantId} />
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Zoek attribuut..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetchWoo()}
            disabled={wooLoading || !tenantId}
            title="WooCommerce attributen herladen"
          >
            {wooLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {/* Summary */}
        {tenantId && modisAttrs && wooAttrs && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{modisAttrs.length} Modis attributen</Badge>
            <Badge variant="outline">{wooAttrs.length} WooCommerce attributen</Badge>
            <Badge variant="outline" className="bg-success/10 text-success border-success/20">
              <Link2 className="h-3 w-3 mr-1" />
              {matchedCount} gematcht
            </Badge>
            {unmatchedCount > 0 && (
              <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20">
                <Unlink className="h-3 w-3 mr-1" />
                {unmatchedCount} Modis niet gematcht
              </Badge>
            )}
            {unmatchedWoo && unmatchedWoo.length > 0 && (
              <Badge variant="outline" className="bg-muted text-muted-foreground">
                {unmatchedWoo.length} WC zonder Modis bron
              </Badge>
            )}
          </div>
        )}

        {!tenantId ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Selecteer een tenant om attributen te vergelijken
          </p>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Attributen laden...</span>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Modis attributes with WC match status */}
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-muted-foreground mb-2">Modis Attributen</h3>
              {filtered?.map((attr) => {
                const wooMatch = getWooMatch(attr.name);
                const key = `modis-${attr.name}`;
                const isOpen = openAttrs.has(key);

                return (
                  <Collapsible key={key} open={isOpen} onOpenChange={() => toggleAttr(key)}>
                    <CollapsibleTrigger className="flex items-center gap-3 w-full px-4 py-2.5 bg-card border border-border rounded-lg hover:bg-muted/50 transition-colors text-left">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-sm font-medium flex-1">{attr.name}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {attr.count} producten
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {attr.values.length} waarden
                      </Badge>
                      {wooMatch ? (
                        <Badge variant="outline" className="text-[10px] bg-success/10 text-success border-success/20">
                          <Check className="h-3 w-3 mr-1" />
                          WC: {wooMatch.name} ({wooMatch.slug})
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] bg-warning/10 text-warning border-warning/20">
                          <Unlink className="h-3 w-3 mr-1" />
                          Geen WC match
                        </Badge>
                      )}
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-7 mt-1 mb-2 px-4 py-3 bg-muted/30 rounded-lg border border-border/50 space-y-3">
                        {/* Modis values */}
                        <div>
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                            Modis waarden ({attr.values.length})
                          </span>
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {attr.values.slice(0, 30).map((v) => (
                              <Badge key={v} variant="outline" className="text-xs font-normal">
                                {v}
                              </Badge>
                            ))}
                            {attr.values.length > 30 && (
                              <Badge variant="secondary" className="text-[10px]">
                                +{attr.values.length - 30} meer
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* WC terms comparison */}
                        {wooMatch && wooMatch.terms.length > 0 && (
                          <div>
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                              WooCommerce termen ({wooMatch.terms.length})
                            </span>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              {wooMatch.terms.slice(0, 30).map((t) => {
                                const inModis = attr.values.some(
                                  (v) => v.toLowerCase() === t.name.toLowerCase()
                                );
                                return (
                                  <Badge
                                    key={t.id}
                                    variant={inModis ? "default" : "outline"}
                                    className={`text-xs font-normal ${
                                      !inModis ? "border-destructive/30 text-destructive" : ""
                                    }`}
                                  >
                                    {t.name}
                                    <span className="ml-1 text-[10px] opacity-60">({t.count})</span>
                                  </Badge>
                                );
                              })}
                              {wooMatch.terms.length > 30 && (
                                <Badge variant="secondary" className="text-[10px]">
                                  +{wooMatch.terms.length - 30} meer
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Value diff summary */}
                        {wooMatch && (
                          <div className="text-xs text-muted-foreground">
                            {(() => {
                              const modisSet = new Set(attr.values.map((v) => v.toLowerCase()));
                              const wooSet = new Set(wooMatch.terms.map((t) => t.name.toLowerCase()));
                              const onlyModis = attr.values.filter((v) => !wooSet.has(v.toLowerCase()));
                              const onlyWoo = wooMatch.terms.filter((t) => !modisSet.has(t.name.toLowerCase()));
                              return (
                                <>
                                  {onlyModis.length > 0 && (
                                    <span className="text-warning">
                                      {onlyModis.length} waarden alleen in Modis.{" "}
                                    </span>
                                  )}
                                  {onlyWoo.length > 0 && (
                                    <span className="text-destructive">
                                      {onlyWoo.length} termen alleen in WooCommerce.
                                    </span>
                                  )}
                                  {onlyModis.length === 0 && onlyWoo.length === 0 && (
                                    <span className="text-success">✓ Alle waarden komen overeen</span>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>

            {/* Unmatched WC attributes */}
            {unmatchedWoo && unmatchedWoo.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">
                  WooCommerce attributen zonder Modis bron
                </h3>
                {unmatchedWoo.map((wa) => (
                  <div
                    key={wa.id}
                    className="flex items-center gap-3 px-4 py-2.5 bg-card border border-border rounded-lg"
                  >
                    <span className="text-sm flex-1">{wa.name}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {wa.slug}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {wa.termCount} termen
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
