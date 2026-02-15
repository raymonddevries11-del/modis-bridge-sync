import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, Loader2, Play, ArrowRight, Image, Link } from "lucide-react";

interface ValidationSample {
  sku: string;
  slugChange: { old: string | null; new: string } | null;
  imgChange: { oldCount: number; newCount: number; hadStorage: boolean } | null;
}

interface ValidationSummary {
  wooProductsInMap: number;
  localProcessed: number;
  localTotal: number;
  slugUpdated: number;
  imgUpdated: number;
  bothUpdated: number;
  totalUpdated: number;
  alreadyCorrect: number;
  notInWoo: number;
  errors: number;
  dryRun: boolean;
  nextOffset: number | null;
}

export function WooUrlValidator({ tenantId }: { tenantId: string }) {
  const [running, setRunning] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const [samples, setSamples] = useState<ValidationSample[]>([]);
  const { toast } = useToast();

  const runValidation = async () => {
    setRunning(true);
    setProgress(0);
    setSummary(null);
    setSamples([]);

    try {
      let offset = 0;
      let totalUpdated = 0;
      let totalCorrect = 0;
      let totalNotInWoo = 0;
      let totalErrors = 0;
      let totalSlug = 0;
      let totalImg = 0;
      let totalBoth = 0;
      let localTotal = 0;
      let wooMapSize = 0;
      let allSamples: ValidationSample[] = [];
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase.functions.invoke("validate-woo-urls", {
          body: { tenantId, dryRun, localOffset: offset, localLimit: 500 },
        });

        if (error) throw new Error(error.message);
        if (!data?.summary) throw new Error("Unexpected response");

        const s = data.summary as ValidationSummary;
        localTotal = s.localTotal;
        wooMapSize = s.wooProductsInMap;
        totalUpdated += s.totalUpdated;
        totalCorrect += s.alreadyCorrect;
        totalNotInWoo += s.notInWoo;
        totalErrors += s.errors;
        totalSlug += s.slugUpdated;
        totalImg += s.imgUpdated;
        totalBoth += s.bothUpdated;

        if (data.samples) {
          allSamples = [...allSamples, ...data.samples].slice(0, 50);
        }

        hasMore = !!s.nextOffset;
        offset = s.nextOffset || 0;
        setProgress(Math.round(((offset || localTotal) / localTotal) * 100));

        // Safety limit
        if (offset > 10000) break;
      }

      const finalSummary: ValidationSummary = {
        wooProductsInMap: wooMapSize,
        localProcessed: localTotal,
        localTotal,
        slugUpdated: totalSlug,
        imgUpdated: totalImg,
        bothUpdated: totalBoth,
        totalUpdated,
        alreadyCorrect: totalCorrect,
        notInWoo: totalNotInWoo,
        errors: totalErrors,
        dryRun,
        nextOffset: null,
      };

      setSummary(finalSummary);
      setSamples(allSamples);
      setProgress(100);

      toast({
        title: dryRun ? "Dry run voltooid" : "Validatie voltooid",
        description: `${totalUpdated} producten ${dryRun ? "zouden bijgewerkt worden" : "bijgewerkt"}`,
      });
    } catch (err: any) {
      toast({ title: "Validatie mislukt", description: err.message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Action card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            WooCommerce URL &amp; Image Validator
          </CardTitle>
          <CardDescription>
            Haalt alle WooCommerce-producten op en vergelijkt slugs en afbeeldings-URLs met de lokale database.
            Vervangt verouderde/storage URLs door de actuele WooCommerce-waarden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch id="dry-run" checked={dryRun} onCheckedChange={setDryRun} disabled={running} />
              <Label htmlFor="dry-run" className="text-sm">
                Dry run {dryRun ? "(alleen rapport, geen wijzigingen)" : "(wijzigingen worden direct doorgevoerd)"}
              </Label>
            </div>
            <Button onClick={runValidation} disabled={running || !tenantId}>
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Bezig…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Start validatie
                </>
              )}
            </Button>
          </div>

          {running && (
            <div className="space-y-1">
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground">{progress}% verwerkt</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatCard label="WC producten" value={summary.wooProductsInMap} />
            <StatCard label="Lokaal verwerkt" value={summary.localProcessed} />
            <StatCard label="Al correct" value={summary.alreadyCorrect} variant="success" />
            <StatCard label="Slug bijgewerkt" value={summary.slugUpdated} icon={<Link className="h-3.5 w-3.5" />} variant="info" />
            <StatCard label="Images bijgewerkt" value={summary.imgUpdated} icon={<Image className="h-3.5 w-3.5" />} variant="info" />
            <StatCard label="Beide bijgewerkt" value={summary.bothUpdated} variant="warning" />
            <StatCard label="Niet in WC" value={summary.notInWoo} variant="muted" />
            <StatCard label="Fouten" value={summary.errors} variant="error" />
          </div>

          {summary.dryRun && summary.totalUpdated > 0 && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-4 flex items-center gap-3">
                <ArrowRight className="h-5 w-5 text-primary flex-shrink-0" />
                <p className="text-sm">
                  <strong>{summary.totalUpdated}</strong> producten zouden bijgewerkt worden.
                  Schakel dry run uit en draai opnieuw om de wijzigingen door te voeren.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Sample table */}
          {samples.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Voorbeeld wijzigingen ({samples.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border max-h-[400px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[120px]">SKU</TableHead>
                        <TableHead>Slug</TableHead>
                        <TableHead>Afbeeldingen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {samples.map((s) => (
                        <TableRow key={s.sku}>
                          <TableCell className="font-mono text-sm">{s.sku}</TableCell>
                          <TableCell>
                            {s.slugChange ? (
                              <div className="text-xs space-y-0.5">
                                <span className="text-muted-foreground line-through">{s.slugChange.old || "—"}</span>
                                <br />
                                <span className="text-primary font-medium">{s.slugChange.new}</span>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {s.imgChange ? (
                              <div className="flex items-center gap-2 text-xs">
                                <Badge variant="outline">{s.imgChange.oldCount} → {s.imgChange.newCount}</Badge>
                                {s.imgChange.hadStorage && (
                                  <Badge variant="secondary">had storage URL</Badge>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, variant = "default" }: {
  label: string; value: number; icon?: React.ReactNode; variant?: "default" | "success" | "warning" | "error" | "info" | "muted";
}) {
  const colors = {
    default: "",
    success: "text-success",
    warning: "text-warning",
    error: "text-destructive",
    info: "text-primary",
    muted: "text-muted-foreground",
  };

  return (
    <Card>
      <CardContent className="p-4 text-center">
        <p className={`text-2xl font-bold ${colors[variant]}`}>{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
          {icon}{label}
        </p>
      </CardContent>
    </Card>
  );
}
