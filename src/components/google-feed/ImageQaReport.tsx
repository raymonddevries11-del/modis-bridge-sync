import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { Download, RefreshCw, ImageOff, AlertTriangle, Loader2 } from "lucide-react";

interface ImageIssue {
  sku: string;
  title: string;
  reason: string;
  urls: string[];
}

interface ImageReport {
  id: string;
  created_at: string;
  total_issues: number;
  by_reason: {
    no_images: number;
    only_supabase_storage_urls: number;
    unsupported_format: number;
    mixed_invalid: number;
  };
  products: ImageIssue[];
}

const REASON_LABELS: Record<string, { label: string; variant: "destructive" | "secondary" | "outline" }> = {
  no_images: { label: "Geen afbeeldingen", variant: "destructive" },
  only_supabase_storage_urls: { label: "Alleen storage URLs", variant: "secondary" },
  unsupported_format: { label: "Ongeldig formaat", variant: "outline" },
  mixed_invalid: { label: "Gemengd ongeldig", variant: "outline" },
};

export function ImageQaReport({ tenantId }: { tenantId: string }) {
  const [report, setReport] = useState<ImageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId) loadReport();
  }, [tenantId]);

  const loadReport = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("changelog")
        .select("id, created_at, metadata")
        .eq("tenant_id", tenantId)
        .eq("event_type", "FEED_IMAGE_ISSUES")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data?.metadata) {
        const meta = data.metadata as any;
        setReport({
          id: data.id,
          created_at: data.created_at,
          total_issues: meta.total_issues || 0,
          by_reason: meta.by_reason || {},
          products: meta.products || [],
        });
      } else {
        setReport(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!report?.products?.length) return;
    const items = filteredProducts;
    const header = "SKU,Titel,Reden,Afbeeldings URLs\n";
    const rows = items
      .map(
        (p) =>
          `"${p.sku}","${p.title.replace(/"/g, '""')}","${REASON_LABELS[p.reason]?.label || p.reason}","${(p.urls || []).join("; ")}"`
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `image-qa-report-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredProducts = report?.products?.filter(
    (p) => !filter || p.reason === filter
  ) || [];

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  if (!report) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <ImageOff className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>Nog geen afbeeldingsrapport beschikbaar.</p>
          <p className="text-sm mt-1">Het rapport wordt automatisch gegenereerd bij de volgende feed-crawl.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card
          className={`cursor-pointer transition-colors ${!filter ? "ring-2 ring-primary" : ""}`}
          onClick={() => setFilter(null)}
        >
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-foreground">{report.total_issues}</p>
            <p className="text-xs text-muted-foreground">Totaal overgeslagen</p>
          </CardContent>
        </Card>
        {Object.entries(REASON_LABELS).map(([key, { label }]) => {
          const count = (report.by_reason as any)?.[key] || 0;
          if (count === 0) return null;
          return (
            <Card
              key={key}
              className={`cursor-pointer transition-colors ${filter === key ? "ring-2 ring-primary" : ""}`}
              onClick={() => setFilter(filter === key ? null : key)}
            >
              <CardContent className="p-4 text-center">
                <p className="text-2xl font-bold text-foreground">{count}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Actions */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Producten zonder geldige afbeelding
              </CardTitle>
              <CardDescription>
                Laatst bijgewerkt: {new Date(report.created_at).toLocaleString("nl-NL")}
                {" · "}{filteredProducts.length} producten
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={loadReport}>
                <RefreshCw className="h-4 w-4 mr-1" /> Vernieuwen
              </Button>
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={filteredProducts.length === 0}>
                <Download className="h-4 w-4 mr-1" /> Exporteer CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border max-h-[500px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">SKU</TableHead>
                  <TableHead>Titel</TableHead>
                  <TableHead className="w-[160px]">Reden</TableHead>
                  <TableHead>Huidige URLs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      Geen producten gevonden
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredProducts.slice(0, 200).map((p) => (
                    <TableRow key={p.sku}>
                      <TableCell className="font-mono text-sm">{p.sku}</TableCell>
                      <TableCell className="max-w-[250px] truncate">{p.title}</TableCell>
                      <TableCell>
                        <Badge variant={REASON_LABELS[p.reason]?.variant || "outline"}>
                          {REASON_LABELS[p.reason]?.label || p.reason}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[300px]">
                        {p.urls?.length > 0 ? (
                          <span className="text-xs text-muted-foreground truncate block">
                            {p.urls[0]?.split("/").pop()}
                            {p.urls.length > 1 && ` +${p.urls.length - 1}`}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {filteredProducts.length > 200 && (
            <p className="text-sm text-muted-foreground mt-2 text-center">
              Toont 200 van {filteredProducts.length} producten. Exporteer CSV voor het volledige overzicht.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
