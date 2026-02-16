import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldCheck, Loader2, AlertTriangle, CheckCircle2, XCircle,
  Image, Link2, Package, Tag, DollarSign, Barcode, Download,
} from "lucide-react";

interface IssueItem {
  sku: string;
  title: string;
  reason: string;
}

interface IssueGroup {
  count: number;
  items: IssueItem[];
}

interface ValidationResult {
  summary: {
    totalProducts: number;
    totalVariants: number;
    validItems: number;
    timestamp: string;
  };
  issues: {
    images: IssueGroup;
    urls: IssueGroup;
    stock: IssueGroup;
    prices: IssueGroup;
    categories: IssueGroup;
    gtins: IssueGroup;
  };
}

const ISSUE_CONFIG: Record<string, { label: string; icon: React.ElementType; severity: "critical" | "warning" | "info" }> = {
  images: { label: "Ongeldige afbeeldingen", icon: Image, severity: "critical" },
  urls: { label: "Onbereikbare productpagina's", icon: Link2, severity: "critical" },
  stock: { label: "Ontbrekende voorraaddata", icon: Package, severity: "warning" },
  prices: { label: "Ontbrekende prijzen", icon: DollarSign, severity: "critical" },
  categories: { label: "Geen Google categorie", icon: Tag, severity: "warning" },
  gtins: { label: "Ontbrekende/ongeldige EAN", icon: Barcode, severity: "info" },
};

export function FeedValidator({ tenantId }: { tenantId: string }) {
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null);
  const { toast } = useToast();

  const runValidation = async () => {
    setLoading(true);
    setResult(null);
    setExpandedIssue(null);
    try {
      const { data, error } = await supabase.functions.invoke("validate-merchant-feed", {
        body: { tenantId },
      });
      if (error) throw new Error(error.message);
      setResult(data as ValidationResult);
    } catch (err: any) {
      toast({ title: "Validatie mislukt", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    const rows: string[] = ["Type,SKU,Titel,Reden"];
    for (const [key, group] of Object.entries(result.issues)) {
      const label = ISSUE_CONFIG[key]?.label || key;
      for (const item of group.items) {
        rows.push(`"${label}","${item.sku}","${item.title.replace(/"/g, '""')}","${item.reason.replace(/"/g, '""')}"`);
      }
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `feed-validation-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalIssues = result
    ? Object.values(result.issues).reduce((sum, g) => sum + g.count, 0)
    : 0;

  const criticalCount = result
    ? Object.entries(result.issues)
        .filter(([k]) => ISSUE_CONFIG[k]?.severity === "critical")
        .reduce((sum, [, g]) => sum + g.count, 0)
    : 0;

  const healthScore = result
    ? Math.max(0, Math.round(((result.summary.totalProducts - criticalCount) / Math.max(result.summary.totalProducts, 1)) * 100))
    : 0;

  return (
    <div className="space-y-4">
      {/* Action card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Feed Validator
          </CardTitle>
          <CardDescription>
            Controleert alle producten op de 3 meest voorkomende Google Merchant afkeuringen:
            ongeldige afbeeldingen, onbereikbare productpagina's en ontbrekende voorraaddata.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Button onClick={runValidation} disabled={loading}>
              {loading ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Valideren…</>
              ) : (
                <><ShieldCheck className="h-4 w-4 mr-2" />Validatie starten</>
              )}
            </Button>
            {result && (
              <Button variant="outline" size="sm" onClick={exportCsv}>
                <Download className="h-4 w-4 mr-1" /> Exporteer CSV
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <>
          {/* Health score */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  {healthScore >= 80 ? (
                    <CheckCircle2 className="h-8 w-8 text-green-600" />
                  ) : healthScore >= 50 ? (
                    <AlertTriangle className="h-8 w-8 text-amber-500" />
                  ) : (
                    <XCircle className="h-8 w-8 text-destructive" />
                  )}
                  <div>
                    <p className="text-2xl font-bold">{healthScore}% gezond</p>
                    <p className="text-sm text-muted-foreground">
                      {result.summary.validItems.toLocaleString()} geldige items van {result.summary.totalVariants.toLocaleString()} varianten
                      {" · "}{result.summary.totalProducts.toLocaleString()} producten gecontroleerd
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(result.summary.timestamp).toLocaleString("nl-NL")}
                </p>
              </div>
              <Progress value={healthScore} className="h-2" />
            </CardContent>
          </Card>

          {/* Issue summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {Object.entries(ISSUE_CONFIG).map(([key, config]) => {
              const group = result.issues[key as keyof typeof result.issues];
              const Icon = config.icon;
              const isExpanded = expandedIssue === key;
              return (
                <Card
                  key={key}
                  className={`cursor-pointer transition-colors ${isExpanded ? "ring-2 ring-primary" : ""} ${
                    group.count === 0 ? "opacity-60" : ""
                  }`}
                  onClick={() => setExpandedIssue(isExpanded ? null : (group.count > 0 ? key : null))}
                >
                  <CardContent className="p-4 text-center">
                    <Icon className={`h-5 w-5 mx-auto mb-1 ${
                      group.count === 0 ? "text-green-600" :
                      config.severity === "critical" ? "text-destructive" :
                      config.severity === "warning" ? "text-amber-500" : "text-muted-foreground"
                    }`} />
                    <p className="text-2xl font-bold">{group.count}</p>
                    <p className="text-xs text-muted-foreground leading-tight">{config.label}</p>
                    {group.count === 0 && (
                      <Badge variant="outline" className="mt-1 text-green-600 border-green-600">OK</Badge>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Expanded issue detail */}
          {expandedIssue && result.issues[expandedIssue as keyof typeof result.issues] && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  {ISSUE_CONFIG[expandedIssue]?.label}
                </CardTitle>
                <CardDescription>
                  {result.issues[expandedIssue as keyof typeof result.issues].count} producten getroffen
                  {result.issues[expandedIssue as keyof typeof result.issues].items.length < result.issues[expandedIssue as keyof typeof result.issues].count &&
                    ` (toont eerste ${result.issues[expandedIssue as keyof typeof result.issues].items.length})`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border max-h-[400px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[120px]">SKU</TableHead>
                        <TableHead>Titel</TableHead>
                        <TableHead>Reden</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.issues[expandedIssue as keyof typeof result.issues].items.map((item, i) => (
                        <TableRow key={`${item.sku}-${i}`}>
                          <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                          <TableCell className="max-w-[250px] truncate">{item.title}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{item.reason}</TableCell>
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
