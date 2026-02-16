import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

interface VariationAuditAlertProps {
  tenantId: string;
}

interface MisMappedDetail {
  sku: string;
  expected: string;
  found: string;
}

interface AuditData {
  products_with_variations: number;
  variations_created: number;
  variations_updated: number;
  attr_fixes: number;
  stock_fixes: number;
  mis_mapped_found: number;
  mis_mapped_details: MisMappedDetail[];
}

export const VariationAuditAlert = ({ tenantId }: VariationAuditAlertProps) => {
  const { data: auditEvents } = useQuery({
    queryKey: ["variation-audit-alerts", tenantId],
    queryFn: async () => {
      const { data } = await supabase
        .from("changelog")
        .select("id, description, metadata, created_at")
        .eq("tenant_id", tenantId)
        .eq("event_type", "VARIATION_ATTR_AUDIT")
        .order("created_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
    enabled: !!tenantId,
    refetchInterval: 30000,
  });

  // Also check latest push for audit summary
  const { data: latestPush } = useQuery({
    queryKey: ["latest-push-audit", tenantId],
    queryFn: async () => {
      const { data } = await supabase
        .from("changelog")
        .select("metadata, created_at")
        .eq("tenant_id", tenantId)
        .eq("event_type", "WOO_PRODUCT_PUSH")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      return data;
    },
    enabled: !!tenantId,
    refetchInterval: 30000,
  });

  const pushAudit = latestPush?.metadata as Record<string, any> | null;
  const variationAudit = pushAudit?.variation_audit as AuditData | undefined;
  const recentMisMapped = auditEvents?.filter(
    (e) => new Date(e.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
  );

  const totalRecentFixes = recentMisMapped?.reduce((sum, e) => {
    const meta = e.metadata as Record<string, any> | null;
    return sum + (meta?.attr_fixes ?? 0);
  }, 0) ?? 0;

  if (!variationAudit && totalRecentFixes === 0) return null;

  const hasMisMapped = (variationAudit?.mis_mapped_found ?? 0) > 0 || totalRecentFixes > 0;

  if (!hasMisMapped && variationAudit) {
    // All good — show a success indicator
    return (
      <Alert className="border-success/30 bg-success/5">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <AlertTitle className="text-success">Variatie-mapping correct</AlertTitle>
        <AlertDescription className="text-sm text-muted-foreground">
          Laatste sync: {variationAudit.products_with_variations} producten met variaties,{" "}
          {variationAudit.variations_created} nieuw, {variationAudit.variations_updated} bijgewerkt.
          Alle maat-attributen correct gekoppeld.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <Alert variant="destructive" className="border-destructive/30 bg-destructive/5">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Mis-mapped variaties gedetecteerd</AlertTitle>
        <AlertDescription className="space-y-3">
          <p className="text-sm">
            {variationAudit && (
              <>
                Laatste push: <strong>{variationAudit.mis_mapped_found}</strong> variaties hadden een verkeerde
                maat-toewijzing en zijn automatisch gecorrigeerd.
                {variationAudit.stock_fixes > 0 && (
                  <> Daarnaast <strong>{variationAudit.stock_fixes}</strong> voorraadcorrecties.</>
                )}
              </>
            )}
            {totalRecentFixes > 0 && !variationAudit && (
              <>
                <strong>{totalRecentFixes}</strong> variatie-attributen gecorrigeerd in de afgelopen 24 uur.
              </>
            )}
          </p>

          {/* Show details of mis-mapped variations */}
          {variationAudit?.mis_mapped_details && variationAudit.mis_mapped_details.length > 0 && (
            <div className="rounded-md border border-destructive/20 bg-background p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Recente correcties (max 10):
              </p>
              <div className="space-y-1.5">
                {variationAudit.mis_mapped_details.slice(0, 10).map((m, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-muted-foreground truncate max-w-[200px]">{m.sku}</span>
                    <Badge variant="outline" className="text-destructive border-destructive/30 shrink-0">
                      {m.found || "(leeg)"}
                    </Badge>
                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <Badge variant="outline" className="text-success border-success/30 shrink-0">
                      {m.expected}
                    </Badge>
                  </div>
                ))}
              </div>
              {variationAudit.mis_mapped_details.length > 10 && (
                <p className="text-xs text-muted-foreground mt-2">
                  ... en {variationAudit.mis_mapped_details.length - 10} meer
                </p>
              )}
            </div>
          )}

          {/* Recent audit events timeline */}
          {recentMisMapped && recentMisMapped.length > 1 && (
            <div className="text-xs text-muted-foreground">
              <p className="font-medium mb-1">Audit log (24h):</p>
              {recentMisMapped.slice(0, 5).map((e) => {
                const meta = e.metadata as Record<string, any> | null;
                return (
                  <div key={e.id} className="flex items-center justify-between py-0.5">
                    <span>{e.description}</span>
                    <span className="text-muted-foreground/60">
                      {new Date(e.created_at).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
};
