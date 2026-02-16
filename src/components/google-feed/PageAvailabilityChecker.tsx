import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Globe, Loader2, Play, AlertTriangle, CheckCircle2, ExternalLink, Download } from "lucide-react";

interface CheckResult {
  sku: string;
  product_id: string;
  slug: string;
  url: string;
  status: number | null;
  ok: boolean;
  error?: string;
  redirect_url?: string;
}

interface Summary {
  total: number;
  checked: number;
  ok: number;
  not_found: number;
  redirected: number;
  errors: number;
}

export function PageAvailabilityChecker({ tenantId }: { tenantId: string }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [problems, setProblems] = useState<CheckResult[]>([]);
  const { toast } = useToast();

  const runCheck = async () => {
    setRunning(true);
    setProgress(0);
    setSummary(null);
    setProblems([]);

    try {
      let offset = 0;
      const limit = 50;
      let totalOk = 0, totalNotFound = 0, totalRedirected = 0, totalErrors = 0;
      let totalCount = 0;
      let checked = 0;
      let allProblems: CheckResult[] = [];
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase.functions.invoke("check-page-availability", {
          body: { tenantId, offset, limit },
        });

        if (error) throw new Error(error.message);
        if (!data?.summary) throw new Error("Unexpected response");

        const s = data.summary;
        totalCount = s.total;
        checked += s.checked;
        totalOk += s.ok;
        totalNotFound += s.not_found;
        totalRedirected += s.redirected;
        totalErrors += s.errors;

        if (data.results) {
          allProblems = [...allProblems, ...data.results];
        }

        hasMore = !!s.nextOffset;
        offset = s.nextOffset || 0;
        setProgress(totalCount > 0 ? Math.round((checked / totalCount) * 100) : 0);

        setSummary({
          total: totalCount,
          checked,
          ok: totalOk,
          not_found: totalNotFound,
          redirected: totalRedirected,
          errors: totalErrors,
        });
        setProblems(allProblems);
      }

      setProgress(100);
      toast({
        title: "Controle voltooid",
        description: `${checked} pagina's gecontroleerd, ${totalNotFound} niet gevonden`,
      });
    } catch (err: any) {
      toast({ title: "Controle mislukt", description: err.message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const exportCsv = () => {
    if (problems.length === 0) return;
    const header = "SKU,Slug,URL,Status,Error,Redirect\n";
    const rows = problems.map(p =>
      `"${p.sku}","${p.slug}","${p.url}",${p.status || ''},"${p.error || ''}","${p.redirect_url || ''}"`
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "page-availability-issues.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const healthScore = summary
    ? Math.round((summary.ok / Math.max(summary.checked, 1)) * 100)
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Globe className="h-5 w-5 text-primary" />
            Productpagina Beschikbaarheid
          </CardTitle>
          <CardDescription>
            Controleert of alle WooCommerce productpagina's bereikbaar zijn voor Google's crawler.
            Detecteert 404-fouten, redirects en time-outs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Button onClick={runCheck} disabled={running || !tenantId}>
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Bezig… ({progress}%)
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Start controle
                </>
              )}
            </Button>
            {problems.length > 0 && (
              <Button variant="outline" size="sm" onClick={exportCsv}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            )}
          </div>

          {running && (
            <div className="space-y-1">
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {summary ? `${summary.checked} / ${summary.total} gecontroleerd` : "Starten…"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card>
              <CardContent className="p-4 text-center">
                <p className={`text-2xl font-bold ${(healthScore ?? 0) >= 95 ? 'text-emerald-600' : (healthScore ?? 0) >= 80 ? 'text-amber-500' : 'text-destructive'}`}>
                  {healthScore}%
                </p>
                <p className="text-xs text-muted-foreground">Health Score</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-emerald-600">{summary.ok.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Bereikbaar
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-destructive">{summary.not_found.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> 404 Not Found
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-amber-500">{summary.redirected.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Redirects</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-muted-foreground">{summary.errors.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Fouten/Time-outs</p>
              </CardContent>
            </Card>
          </div>

          {problems.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  Problemen ({problems.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border max-h-[500px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[120px]">SKU</TableHead>
                        <TableHead>Slug</TableHead>
                        <TableHead className="w-[80px]">Status</TableHead>
                        <TableHead>Detail</TableHead>
                        <TableHead className="w-[50px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {problems.map((p, i) => (
                        <TableRow key={`${p.sku}-${i}`}>
                          <TableCell className="font-mono text-sm">{p.sku}</TableCell>
                          <TableCell className="text-sm max-w-[200px] truncate">{p.slug}</TableCell>
                          <TableCell>
                            <Badge variant={p.status === 404 ? "destructive" : p.redirect_url ? "secondary" : "outline"}>
                              {p.status || "ERR"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[250px] truncate">
                            {p.error || (p.redirect_url ? `→ ${p.redirect_url}` : "Niet gevonden")}
                          </TableCell>
                          <TableCell>
                            <a href={p.url} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                            </a>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {problems.length === 0 && summary.checked > 0 && (
            <Card className="border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950">
              <CardContent className="p-4 flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0" />
                <p className="text-sm">
                  Alle {summary.checked.toLocaleString()} productpagina's zijn bereikbaar. Geen problemen gevonden.
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
