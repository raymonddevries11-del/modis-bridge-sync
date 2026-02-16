import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { RefreshCw, Loader2, Search, ChevronDown, ChevronRight, Check, Link2, Unlink, X, ArrowRight } from "lucide-react";
import { TenantSelector } from "@/components/TenantSelector";
import { toast } from "sonner";

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

type AttrMappings = Record<string, string>; // modisName -> wooSlug

export function WooAttributeSync() {
  const queryClient = useQueryClient();
  const [tenantId, setTenantId] = useState("");
  const [search, setSearch] = useState("");
  const [openAttrs, setOpenAttrs] = useState<Set<string>>(new Set());
  const [editingAttr, setEditingAttr] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

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

  // Fetch saved manual mappings from config table
  const configKey = `woo_attribute_mappings_${tenantId}`;
  const { data: savedMappings } = useQuery({
    queryKey: ["woo-attr-mappings-config", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", configKey)
        .maybeSingle();
      return (data?.value as AttrMappings) ?? {};
    },
  });

  const manualMappings: AttrMappings = savedMappings ?? {};

  // Save mapping mutation
  const saveMappingMutation = useMutation({
    mutationFn: async (newMappings: AttrMappings) => {
      const { error } = await supabase
        .from("config")
        .upsert({ key: configKey, value: newMappings as any, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["woo-attr-mappings-config", tenantId] });
      toast.success("Mapping opgeslagen");
    },
    onError: (err: any) => toast.error(`Fout: ${err.message}`),
  });

  const setMapping = (modisName: string, wooSlug: string) => {
    const updated = { ...manualMappings, [modisName]: wooSlug };
    saveMappingMutation.mutate(updated);
    setEditingAttr(null);
    setPopoverOpen(false);
  };

  const removeMapping = (modisName: string) => {
    const updated = { ...manualMappings };
    delete updated[modisName];
    saveMappingMutation.mutate(updated);
  };

  // Auto-match all unmatched Modis attributes by name/slug
  const autoMatchAll = () => {
    if (!wooAttrs || !modisAttrs) return;
    const updated = { ...manualMappings };
    let newMatches = 0;
    for (const ma of modisAttrs) {
      if (updated[ma.name]) continue; // already manually mapped
      const lower = ma.name.toLowerCase().replace(/\s+/g, "-");
      const match = wooAttrs.find(
        (wa) =>
          wa.name.toLowerCase() === ma.name.toLowerCase() ||
          wa.slug === lower ||
          wa.slug === `pa_${lower}`
      );
      if (match) {
        updated[ma.name] = match.slug;
        newMatches++;
      }
    }
    if (newMatches > 0) {
      saveMappingMutation.mutate(updated);
      toast.success(`${newMatches} attributen automatisch gematcht`);
    } else {
      toast.info("Geen nieuwe matches gevonden");
    }
  };

  const toggleAttr = (key: string) => {
    setOpenAttrs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Resolve WC match: manual mapping first, then auto-match by name/slug
  const getWooMatch = (modisName: string): WooAttribute | null => {
    if (!wooAttrs) return null;
    // Check manual mapping first
    const manualSlug = manualMappings[modisName];
    if (manualSlug) {
      const found = wooAttrs.find((wa) => wa.slug === manualSlug);
      if (found) return found;
    }
    // Auto-match
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

  const isManuallyMapped = (modisName: string): boolean => !!manualMappings[modisName];

  const isLoading = wooLoading || modisLoading;

  const filtered = modisAttrs?.filter(
    (a) => a.name.toLowerCase().includes(search.toLowerCase())
  );

  const matchedCount = modisAttrs?.filter((a) => getWooMatch(a.name) !== null).length ?? 0;
  const unmatchedCount = (modisAttrs?.length ?? 0) - matchedCount;

  const unmatchedWoo = useMemo(() => {
    if (!wooAttrs || !modisAttrs) return wooAttrs ?? [];
    const mappedSlugs = new Set(Object.values(manualMappings));
    return wooAttrs.filter((wa) => {
      if (mappedSlugs.has(wa.slug)) return false;
      return !modisAttrs.some((ma) => {
        const lower = ma.name.toLowerCase().replace(/\s+/g, "-");
        return (
          wa.name.toLowerCase() === ma.name.toLowerCase() ||
          wa.slug === lower ||
          wa.slug === `pa_${lower}`
        );
      });
    });
  }, [wooAttrs, modisAttrs, manualMappings]);

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
          {wooAttrs && (
            <Badge variant="secondary" className="text-[10px]">
              {wooAttrs.length} WC attributen
            </Badge>
          )}
          {wooAttrs && modisAttrs && unmatchedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={autoMatchAll}
              disabled={saveMappingMutation.isPending}
              className="text-xs"
            >
              <Link2 className="h-3.5 w-3.5 mr-1" />
              Auto-match alle
            </Button>
          )}
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
                {unmatchedCount} niet gematcht
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
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-muted-foreground mb-2">Modis Attributen</h3>
              {filtered?.map((attr) => {
                const wooMatch = getWooMatch(attr.name);
                const isManual = isManuallyMapped(attr.name);
                const key = `modis-${attr.name}`;
                const isOpen = openAttrs.has(key);
                const isEditing = editingAttr === attr.name;

                return (
                  <Collapsible key={key} open={isOpen} onOpenChange={() => toggleAttr(key)}>
                    <div className="flex items-center gap-2 px-4 py-2.5 bg-card border border-border rounded-lg hover:bg-muted/50 transition-colors group">
                      <CollapsibleTrigger className="flex items-center gap-3 flex-1 text-left min-w-0">
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                        <span className="text-sm font-medium truncate">{attr.name}</span>
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          {attr.count}
                        </Badge>
                      </CollapsibleTrigger>

                      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />

                      {/* WC mapping area */}
                      <div className="flex items-center gap-2 min-w-0 shrink-0">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 text-sm justify-start min-w-[220px] font-normal truncate"
                                >
                                  {wooMatch ? `${wooMatch.name} (${wooMatch.slug})` : "Kies WC attribuut..."}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[350px] p-0 z-50 bg-popover" align="end">
                                <Command>
                                  <CommandInput placeholder="Zoek WC attribuut..." />
                                  <CommandList>
                                    <CommandEmpty>Geen attributen gevonden</CommandEmpty>
                                    <CommandGroup>
                                      {wooAttrs?.map((wa) => (
                                        <CommandItem
                                          key={wa.id}
                                          value={`${wa.name} ${wa.slug}`}
                                          onSelect={() => setMapping(attr.name, wa.slug)}
                                        >
                                          <div className="flex items-center gap-2 w-full">
                                            <span className="truncate flex-1">{wa.name}</span>
                                            <Badge variant="secondary" className="text-[10px] shrink-0">
                                              {wa.slug}
                                            </Badge>
                                            <Badge variant="secondary" className="text-[10px] shrink-0">
                                              {wa.termCount} termen
                                            </Badge>
                                          </div>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { setEditingAttr(null); setPopoverOpen(false); }}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : wooMatch ? (
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={`text-[10px] max-w-[220px] truncate ${
                                isManual
                                  ? "bg-primary/10 text-primary border-primary/20"
                                  : "bg-success/10 text-success border-success/20"
                              }`}
                            >
                              <Check className="h-3 w-3 mr-1 shrink-0" />
                              {wooMatch.name} ({wooMatch.slug})
                            </Badge>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={(e) => { e.stopPropagation(); setEditingAttr(attr.name); }}
                              >
                                Wijzig
                              </Button>
                              {isManual && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                  onClick={(e) => { e.stopPropagation(); removeMapping(attr.name); }}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs text-muted-foreground"
                            onClick={(e) => { e.stopPropagation(); setEditingAttr(attr.name); }}
                          >
                            + Map naar WooCommerce
                          </Button>
                        )}
                      </div>
                    </div>

                    <CollapsibleContent>
                      <div className="ml-7 mt-1 mb-2 px-4 py-3 bg-muted/30 rounded-lg border border-border/50 space-y-3">
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

            {unmatchedWoo.length > 0 && (
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
