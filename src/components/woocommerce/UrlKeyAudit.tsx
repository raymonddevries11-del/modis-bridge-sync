import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Play, Wrench, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

interface UrlKeyAuditProps {
  tenantId: string;
}

interface DryRunResult {
  sku: string;
  title: string;
  oldKey: string | null;
  newSlug: string | null;
  status: string;
}

export function UrlKeyAudit({ tenantId }: UrlKeyAuditProps) {
  const navigate = useNavigate();
  const [dryRunResults, setDryRunResults] = useState<DryRunResult[] | null>(null);
  const [runningDryRun, setRunningDryRun] = useState(false);
  const [creatingJob, setCreatingJob] = useState(false);
  const [schedulingDryRun, setSchedulingDryRun] = useState(false);

  const { data: brokenProducts = [], isLoading } = useQuery({
    queryKey: ["url-key-audit", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id, sku, title, url_key")
        .eq("tenant_id", tenantId)
        .or("url_key.eq.-nvt,url_key.is.null,url_key.eq.");
      if (error) throw error;
      return data ?? [];
    },
  });

  const countNull = brokenProducts.filter((p) => p.url_key === null).length;
  const countEmpty = brokenProducts.filter((p) => p.url_key === "").length;
  const countNvt = brokenProducts.filter((p) => p.url_key === "-nvt").length;

  const handleDryRun = async () => {
    setRunningDryRun(true);
    setDryRunResults(null);
    try {
      const { data, error } = await supabase.functions.invoke("fix-url-keys", {
        body: { tenantId, dryRun: true },
      });
      if (error) throw error;
      setDryRunResults(data?.results ?? []);
    } catch (e: any) {
      toast.error(`Dry run mislukt: ${e.message}`);
    } finally {
      setRunningDryRun(false);
    }
  };

  const handleScheduleDryRun = async () => {
    setSchedulingDryRun(true);
    try {
      const { error } = await supabase.from("jobs").insert({
        type: "DRY_RUN_FIX_URL_KEYS",
        state: "ready" as const,
        payload: { tenantId, dryRun: true },
        tenant_id: tenantId,
      });
      if (error && (error.code === "23505" || error.message?.includes("idx_jobs_dedupe"))) {
        toast.info("Er staat al een Dry Run job klaar");
        return;
      }
      if (error) throw error;
      toast.success("Dry Run job ingepland", {
        action: { label: "Bekijk Jobs", onClick: () => navigate("/jobs") },
      });
    } catch (e: any) {
      toast.error(`Fout: ${e.message}`);
    } finally {
      setSchedulingDryRun(false);
    }
  };

  const handleAutoRepair = async () => {
    setCreatingJob(true);
    try {
      const { error } = await supabase.from("jobs").insert({
        type: "FIX_URL_KEYS",
        state: "ready" as const,
        payload: { tenantId },
        tenant_id: tenantId,
      });
      if (error && (error.code === "23505" || error.message?.includes("idx_jobs_dedupe"))) {
        toast.info("Er staat al een FIX_URL_KEYS job klaar");
        return;
      }
      if (error) throw error;
      toast.success("Fix URL Keys job aangemaakt", {
        action: { label: "Bekijk Jobs", onClick: () => navigate("/jobs") },
      });
    } catch (e: any) {
      toast.error(`Fout: ${e.message}`);
    } finally {
      setCreatingJob(false);
    }
  };

  if (!tenantId) return null;

  return (
    <Card className="card-elevated">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          URL Key Audit
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary badges */}
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            Totaal: {brokenProducts.length}
          </Badge>
          {countNull > 0 && (
            <Badge variant="destructive">null: {countNull}</Badge>
          )}
          {countEmpty > 0 && (
            <Badge variant="destructive">leeg: {countEmpty}</Badge>
          )}
          {countNvt > 0 && (
            <Badge variant="secondary">-nvt: {countNvt}</Badge>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={brokenProducts.length === 0 || runningDryRun}
            onClick={handleDryRun}
          >
            {runningDryRun ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Dry Run
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={brokenProducts.length === 0 || schedulingDryRun}
            onClick={handleScheduleDryRun}
          >
            {schedulingDryRun ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Plan Dry Run
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={brokenProducts.length === 0 || creatingJob}
            onClick={handleAutoRepair}
          >
            {creatingJob ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="mr-2 h-4 w-4" />
            )}
            Fix alle
          </Button>
        </div>

        {/* Broken products table */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Laden...</p>
        ) : brokenProducts.length === 0 ? (
          <p className="text-sm text-muted-foreground">✅ Geen gebroken URL keys gevonden.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Titel</TableHead>
                  <TableHead>URL Key</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {brokenProducts.slice(0, 50).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs">{p.title}</TableCell>
                    <TableCell className="font-mono text-xs">{p.url_key ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={p.url_key === null ? "destructive" : "secondary"} className="text-xs">
                        {p.url_key === null ? "null" : p.url_key === "" ? "leeg" : p.url_key}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {brokenProducts.length > 50 && (
              <p className="p-2 text-xs text-muted-foreground text-center">
                +{brokenProducts.length - 50} meer…
              </p>
            )}
          </div>
        )}

        {/* Dry run results */}
        {dryRunResults && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Dry Run Resultaten</h4>
            <div className="max-h-48 overflow-auto rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Nieuwe Slug</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dryRunResults.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                      <TableCell className="font-mono text-xs">{r.newSlug ?? "—"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={r.status === "would fix" ? "default" : "destructive"}
                          className="text-xs"
                        >
                          {r.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
