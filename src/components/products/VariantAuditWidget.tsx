import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, Search, ChevronDown, ChevronUp, Footprints } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface Props {
  tenantId: string;
}

interface AuditIssue {
  sku: string;
  title: string;
  productId: string;
  isSneaker: boolean;
  issues: string[];
  variantCount: number;
  activeVariantCount: number;
  missingMaatIds: string[];
  missingEans: string[];
  missingSizeLabels: string[];
}

interface AuditResult {
  success: boolean;
  summary: {
    totalProducts: number;
    productsWithIssues: number;
    noVariants: number;
    legacyMaatIds: number;
    missingEans: number;
    sneakerIssues: number;
  };
  issues: AuditIssue[];
}

export const VariantAuditWidget = ({ tenantId }: Props) => {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch, isFetching } = useQuery<AuditResult>({
    queryKey: ["variant-audit", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        "audit-variant-completeness",
        { body: { tenantId } }
      );
      if (error) throw error;
      return data;
    },
    enabled: false,
  });

  const toggleExpand = (sku: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(sku) ? next.delete(sku) : next.add(sku);
      return next;
    });
  };

  const handleRun = () => {
    setOpen(true);
    refetch();
  };

  const summary = data?.summary;
  const issues = data?.issues || [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="border-dashed">
        <CardHeader className="py-3 px-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Footprints className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">
                Variant / Maat Audit
              </CardTitle>
              {summary && (
                <Badge
                  variant={summary.productsWithIssues > 0 ? "destructive" : "default"}
                  className="text-xs"
                >
                  {summary.productsWithIssues} issues
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRun}
                disabled={isFetching}
                className="text-xs h-7"
              >
                {isFetching ? "Scannen..." : "Audit uitvoeren"}
              </Button>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                  {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="pt-0 px-4 pb-4">
            {isLoading && <p className="text-sm text-muted-foreground">Laden...</p>}

            {summary && (
              <div className="space-y-3">
                {/* Summary row */}
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
                  <SumStat label="Producten" value={summary.totalProducts} />
                  <SumStat label="Met issues" value={summary.productsWithIssues} warn={summary.productsWithIssues > 0} />
                  <SumStat label="Geen maten" value={summary.noVariants} warn={summary.noVariants > 0} />
                  <SumStat label="Legacy maat_id" value={summary.legacyMaatIds} warn={summary.legacyMaatIds > 0} />
                  <SumStat label="Geen EAN" value={summary.missingEans} warn={summary.missingEans > 0} />
                  <SumStat label="Schoenen" value={summary.sneakerIssues} warn={summary.sneakerIssues > 0} />
                </div>

                {issues.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-green-600">
                    <CheckCircle className="h-4 w-4" />
                    Alle producten hebben complete variant data
                  </div>
                ) : (
                  <ScrollArea className="h-[320px] rounded border">
                    <div className="divide-y">
                      {issues.map((item) => (
                        <div
                          key={item.sku}
                          className="px-3 py-2 hover:bg-muted/50 cursor-pointer"
                          onClick={() => toggleExpand(item.sku)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono text-xs shrink-0">{item.sku}</span>
                              {item.isSneaker && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger>
                                      <Footprints className="h-3 w-3 text-orange-500" />
                                    </TooltipTrigger>
                                    <TooltipContent>Schoenproduct</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              <span className="text-xs text-muted-foreground truncate">{item.title}</span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Badge variant="outline" className="text-xs">
                                {item.activeVariantCount}/{item.variantCount} maten
                              </Badge>
                              <Badge variant="destructive" className="text-xs">
                                {item.issues.length}
                              </Badge>
                            </div>
                          </div>

                          {expanded.has(item.sku) && (
                            <div className="mt-2 pl-2 space-y-1 text-xs text-muted-foreground">
                              {item.issues.map((issue, i) => (
                                <div key={i} className="flex items-start gap-1.5">
                                  <AlertTriangle className="h-3 w-3 text-yellow-500 mt-0.5 shrink-0" />
                                  <span>{issue}</span>
                                </div>
                              ))}
                              {item.missingMaatIds.length > 0 && (
                                <div className="mt-1 text-xs">
                                  <span className="font-medium">Legacy maat_ids:</span>{" "}
                                  {item.missingMaatIds.slice(0, 10).join(", ")}
                                  {item.missingMaatIds.length > 10 && ` +${item.missingMaatIds.length - 10} meer`}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            )}

            {!summary && !isLoading && (
              <p className="text-xs text-muted-foreground">
                Klik "Audit uitvoeren" om producten te scannen op ontbrekende maten, legacy maat_id's en missende EAN-codes.
              </p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};

function SumStat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded bg-muted/50 p-1.5">
      <div className={`text-lg font-bold ${warn ? "text-destructive" : ""}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground leading-tight">{label}</div>
    </div>
  );
}
