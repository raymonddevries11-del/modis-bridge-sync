import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileSpreadsheet, CheckCircle2, AlertCircle, Clock, MinusCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { nl } from "date-fns/locale";

interface ImportFileStatus {
  filename: string;
  eventType: string;
  lastRun: string;
  outcome: "success" | "warning" | "empty" | "error";
  details: string;
}

function deriveOutcome(entry: Record<string, any>): { outcome: ImportFileStatus["outcome"]; details: string } {
  const meta = entry.metadata as Record<string, any> | null;
  if (!meta) return { outcome: "empty", details: "Geen metadata" };

  const errorCount = meta.error_count || meta.errors?.length || 0;
  if (errorCount > 0) return { outcome: "error", details: `${errorCount} fouten` };

  const eventType = entry.event_type as string;

  if (eventType === "NEW_PRODUCTS_DETECTED") {
    const count = meta.count || meta.new_skus?.length || 0;
    return { outcome: "success", details: `${count} nieuwe SKU('s) gedetecteerd` };
  }

  if (eventType === "PRODUCT_IMPORT_ERROR") {
    return { outcome: "error", details: meta.error_message || "Import mislukt" };
  }

  if (eventType === "PRODUCT_CSV_IMPORT") {
    const inserted = meta.productsInserted || 0;
    const updated = meta.productsUpdated || 0;
    const vNew = meta.variantsInserted || 0;
    const vUp = meta.variantsUpdated || 0;
    const total = inserted + updated + vNew + vUp;
    if (meta.valid === false) return { outcome: "error", details: meta.validation_errors?.join(', ') || "Validatie mislukt" };
    if (total === 0) return { outcome: "empty", details: "0 wijzigingen" };
    return { outcome: "success", details: `${inserted} nieuw, ${updated} bijgewerkt, ${vNew}/${vUp} var` };
  }

  if (eventType === "STOCK_CSV_IMPORT" || eventType === "STOCK_IMPORT") {
    const uv = meta.updated_variants || 0;
    const up = meta.updated_prices || 0;
    const skipped = meta.skipped_rows || meta.skipped_variants || 0;
    const changed = (meta.changed_variants || 0) + (meta.changed_products || 0) + (meta.changedVariants || 0) + (meta.changedProducts || 0);
    if (uv === 0 && up === 0 && changed === 0 && skipped > 0) return { outcome: "warning", details: `${skipped} overgeslagen` };
    if (uv === 0 && up === 0 && changed === 0) return { outcome: "empty", details: "0 wijzigingen" };
    return { outcome: "success", details: `${uv} voorraad, ${up} prijzen${changed > 0 ? `, ${changed} gewijzigd` : ""}` };
  }

  return { outcome: "success", details: "Verwerkt" };
}

const outcomeConfig = {
  success: { icon: CheckCircle2, color: "text-emerald-500", badge: "default" as const, label: "OK" },
  warning: { icon: MinusCircle, color: "text-amber-500", badge: "secondary" as const, label: "Waarschuwing" },
  empty: { icon: Clock, color: "text-muted-foreground", badge: "outline" as const, label: "Geen wijzigingen" },
  error: { icon: AlertCircle, color: "text-destructive", badge: "destructive" as const, label: "Fout" },
};

export function CsvImportStatusWidget() {
  const { data: fileStatuses = [], isLoading } = useQuery({
    queryKey: ["csv-import-file-statuses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("changelog")
        .select("event_type, description, metadata, created_at")
        .in("event_type", ["PRODUCT_CSV_IMPORT", "STOCK_CSV_IMPORT", "STOCK_IMPORT", "NEW_PRODUCTS_DETECTED", "PRODUCT_IMPORT_ERROR"])
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      // Group by filename, keep latest per file
      const byFile = new Map<string, ImportFileStatus>();
      for (const entry of data || []) {
        const meta = entry.metadata as Record<string, any> | null;
        const filename = meta?.filename || "Onbekend";
        if (byFile.has(filename)) continue;
        const { outcome, details } = deriveOutcome(entry);
        byFile.set(filename, {
          filename,
          eventType: entry.event_type,
          lastRun: entry.created_at,
          outcome,
          details,
        });
      }

      return Array.from(byFile.values()).slice(0, 12);
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            Import Status per Bestand
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Laden...</p>
        </CardContent>
      </Card>
    );
  }

  if (fileStatuses.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            Import Status per Bestand
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Geen recente imports gevonden.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          Import Status per Bestand
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          {fileStatuses.map((file) => {
            const config = outcomeConfig[file.outcome];
            const Icon = config.icon;
            return (
              <div key={file.filename} className="flex items-center gap-3 px-4 py-2.5">
                <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono truncate" title={file.filename}>
                    {file.filename}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{file.details}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={config.badge} className="text-[10px] px-1.5 py-0">
                    {config.label}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                    {formatDistanceToNow(new Date(file.lastRun), { addSuffix: true, locale: nl })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
