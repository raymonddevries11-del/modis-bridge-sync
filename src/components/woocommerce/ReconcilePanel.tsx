import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Play, AlertTriangle, CheckCircle2, Copy, Unlink, Link2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface ReconcileReport {
  total_pim: number;
  total_cached: number;
  uncached: number;
  orphaned: number;
  stale: number;
  mismatched: number;
  duplicate_links: number;
  orphans_removed: number;
  duplicates_removed: number;
  mismatches_fixed: number;
  syncs_queued: number;
  dry_run: boolean;
  sample_uncached: string[];
  sample_orphaned: string[];
  sample_stale: string[];
  sample_mismatched: Array<{ sku: string; product_id: string; cache_woo_id: number; product_woo_id: number }>;
  sample_duplicate_links: Array<{ product_id: string; woo_ids: number[]; kept_woo_id: number }>;
}

interface Props {
  tenantId: string;
}

export const ReconcilePanel = ({ tenantId }: Props) => {
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [report, setReport] = useState<ReconcileReport | null>(null);

  const runReconcile = async (dryRun: boolean) => {
    dryRun ? setLoading(true) : setApplying(true);
    try {
      const { data, error } = await supabase.functions.invoke("reconcile-product-cache", {
        body: { tenantId, dry_run: dryRun },
      });
      if (error) throw error;
      setReport(data as ReconcileReport);
      if (!dryRun) {
        toast.success(
          `Reconcile klaar: ${data.orphans_removed} orphans, ${data.duplicates_removed} dupes, ${data.mismatches_fixed} mismatches gefixt`
        );
      }
    } catch (e: any) {
      toast.error(`Fout: ${e.message}`);
    } finally {
      setLoading(false);
      setApplying(false);
    }
  };

  const hasIssues = report && (report.orphaned > 0 || report.duplicate_links > 0 || report.mismatched > 0 || report.uncached > 0 || report.stale > 0);
  const isClean = report && !hasIssues;

  return (
    <Card className="card-elevated">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Data Integrity Reconcile</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={loading || applying} onClick={() => runReconcile(true)}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              {loading ? "Scanning..." : "Dry Run"}
            </Button>
            {report && !report.dry_run ? null : (
              <Button
                size="sm"
                disabled={applying || loading || !report || isClean}
                onClick={() => runReconcile(false)}
              >
                {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {applying ? "Fixing..." : "Apply Fixes"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!report && (
          <p className="text-sm text-muted-foreground text-center py-4">
            Voer een dry run uit om data-integriteit te controleren zonder wijzigingen aan te brengen.
          </p>
        )}

        {report && (
          <div className="space-y-4">
            {/* Summary stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryItem label="PIM Producten" value={report.total_pim} />
              <SummaryItem label="WooCommerce Cache" value={report.total_cached} />
              <SummaryItem
                label="Uncached"
                value={report.uncached}
                variant={report.uncached > 0 ? "warning" : "success"}
              />
              <SummaryItem
                label="Orphaned"
                value={report.orphaned}
                variant={report.orphaned > 0 ? "destructive" : "success"}
              />
            </div>

            {/* Issue cards */}
            <div className="space-y-3">
              {report.duplicate_links > 0 && (
                <IssueCard
                  icon={<Copy className="h-4 w-4" />}
                  title="Duplicate Links"
                  count={report.duplicate_links}
                  variant="destructive"
                  fixed={report.duplicates_removed}
                  dryRun={report.dry_run}
                >
                  {report.sample_duplicate_links.map((d, i) => (
                    <div key={i} className="text-xs font-mono bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground">product:</span> {d.product_id.slice(0, 8)}…
                      <span className="ml-2 text-muted-foreground">woo_ids:</span> [{d.woo_ids.join(", ")}]
                      <span className="ml-2 text-muted-foreground">keep:</span>{" "}
                      <span className="text-primary font-semibold">{d.kept_woo_id}</span>
                    </div>
                  ))}
                </IssueCard>
              )}

              {report.mismatched > 0 && (
                <IssueCard
                  icon={<Unlink className="h-4 w-4" />}
                  title="ID Mismatches"
                  count={report.mismatched}
                  variant="warning"
                  fixed={report.mismatches_fixed}
                  dryRun={report.dry_run}
                >
                  {report.sample_mismatched.map((m, i) => (
                    <div key={i} className="text-xs font-mono bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground">SKU:</span> {m.sku}
                      <span className="ml-2 text-muted-foreground">products.woo_id:</span>{" "}
                      <span className="text-destructive">{m.product_woo_id}</span>
                      <span className="ml-1">→</span>
                      <span className="ml-1 text-primary">{m.cache_woo_id}</span>
                    </div>
                  ))}
                </IssueCard>
              )}

              {report.orphaned > 0 && (
                <IssueCard
                  icon={<AlertTriangle className="h-4 w-4" />}
                  title="Orphaned Cache Entries"
                  count={report.orphaned}
                  variant="destructive"
                  fixed={report.orphans_removed}
                  dryRun={report.dry_run}
                >
                  <div className="text-xs font-mono text-muted-foreground">
                    {report.sample_orphaned.slice(0, 5).join(", ")}
                    {report.orphaned > 5 && ` +${report.orphaned - 5} meer`}
                  </div>
                </IssueCard>
              )}

              {report.uncached > 0 && (
                <IssueCard
                  icon={<Link2 className="h-4 w-4" />}
                  title="Uncached PIM Products"
                  count={report.uncached}
                  variant="warning"
                  fixed={report.syncs_queued}
                  dryRun={report.dry_run}
                  fixLabel="queued"
                >
                  <div className="text-xs font-mono text-muted-foreground">
                    {report.sample_uncached.slice(0, 5).join(", ")}
                    {report.uncached > 5 && ` +${report.uncached - 5} meer`}
                  </div>
                </IssueCard>
              )}

              {report.stale > 0 && (
                <IssueCard
                  icon={<AlertTriangle className="h-4 w-4" />}
                  title="Stale Cache Entries"
                  count={report.stale}
                  variant="warning"
                  fixed={0}
                  dryRun={report.dry_run}
                >
                  <div className="text-xs font-mono text-muted-foreground">
                    {report.sample_stale.slice(0, 5).join(", ")}
                    {report.stale > 5 && ` +${report.stale - 5} meer`}
                  </div>
                </IssueCard>
              )}

              {isClean && (
                <div className="flex items-center gap-2 text-sm text-success py-4 justify-center">
                  <CheckCircle2 className="h-5 w-5" />
                  Geen integriteits­problemen gevonden.
                </div>
              )}
            </div>

            {/* Dry run badge */}
            {report.dry_run && (
              <p className="text-xs text-muted-foreground text-center">
                Dit is een dry run — er zijn geen wijzigingen aangebracht. Klik "Apply Fixes" om problemen op te lossen.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

function SummaryItem({ label, value, variant }: { label: string; value: number; variant?: "warning" | "destructive" | "success" }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold ${
        variant === "destructive" ? "text-destructive" :
        variant === "warning" ? "text-warning" :
        variant === "success" ? "text-success" : ""
      }`}>
        {value}
      </p>
    </div>
  );
}

function IssueCard({
  icon, title, count, variant, fixed, dryRun, fixLabel = "fixed", children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  variant: "destructive" | "warning";
  fixed: number;
  dryRun: boolean;
  fixLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-3 space-y-2 ${
      variant === "destructive" ? "border-destructive/30" : "border-warning/30"
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
          <Badge variant={variant === "destructive" ? "destructive" : "secondary"} className="text-xs">
            {count}
          </Badge>
        </div>
        {!dryRun && fixed > 0 && (
          <Badge variant="outline" className="text-xs text-success border-success/30">
            {fixed} {fixLabel}
          </Badge>
        )}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
