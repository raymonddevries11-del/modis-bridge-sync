import { Layout } from "@/components/Layout";
import { CsvImportStatusWidget } from "@/components/activity/CsvImportStatusWidget";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSearchParams, Navigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Activity, Clock, CheckCircle2, AlertCircle, Trash2, RefreshCw, Filter, FileSpreadsheet, Package, TrendingUp, TrendingDown, RotateCcw, Lightbulb } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { nl } from "date-fns/locale";
import { useState } from "react";

const ActivityPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "jobs";

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1>Activity</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor jobs, bekijk logs en volg wijzigingen.
          </p>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => setSearchParams({ tab: v })}
          className="space-y-4"
        >
          <TabsList>
            <TabsTrigger value="jobs">Jobs</TabsTrigger>
            <TabsTrigger value="changelog">Changelog</TabsTrigger>
          </TabsList>

          <TabsContent value="jobs">
            <JobsTab />
          </TabsContent>
          <TabsContent value="changelog">
            <ChangelogTab />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

function JobsTab() {
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs-activity"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
    refetchInterval: 5000,
  });

  const stateIcon = (state: string) => {
    switch (state) {
      case "done": return <CheckCircle2 className="h-4 w-4 text-success" />;
      case "error": return <AlertCircle className="h-4 w-4 text-destructive" />;
      case "processing": return <RefreshCw className="h-4 w-4 text-primary animate-spin" />;
      default: return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Laden...</div>;

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-8 text-center">
        <Activity className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Geen jobs gevonden</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Type</th>
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Created</th>
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="table-row-clean">
              <td className="px-4 py-2.5 flex items-center gap-2">
                {stateIcon(job.state)}
                <span className="capitalize">{job.state}</span>
              </td>
              <td className="px-4 py-2.5 font-mono text-xs">{job.type}</td>
              <td className="px-4 py-2.5 text-muted-foreground">
                {format(new Date(job.created_at), "dd MMM HH:mm")}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-xs truncate">
                {job.error || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangelogTab() {
  const [eventFilter, setEventFilter] = useState<string>("all");

  const { data: importSummary } = useQuery({
    queryKey: ["product-csv-import-summary"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("changelog")
        .select("description, metadata, created_at")
        .eq("event_type", "PRODUCT_CSV_IMPORT")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;

      const lastImport = data?.[0];
      const totalImports = data?.length || 0;

      let totalNew = 0, totalUpdated = 0, totalVariantsNew = 0, totalVariantsUpdated = 0;
      for (const entry of data || []) {
        const meta = entry.metadata as Record<string, any> | null;
        if (meta) {
          totalNew += meta.productsInserted || 0;
          totalUpdated += meta.productsUpdated || 0;
          totalVariantsNew += meta.variantsInserted || 0;
          totalVariantsUpdated += meta.variantsUpdated || 0;
        }
      }

      return { lastImport, totalImports, totalNew, totalUpdated, totalVariantsNew, totalVariantsUpdated };
    },
  });

  const { data: eventTypes = [] } = useQuery({
    queryKey: ["changelog-event-types"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("changelog")
        .select("event_type");
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const row of data) {
        counts.set(row.event_type, (counts.get(row.event_type) || 0) + 1);
      }
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count }));
    },
  });

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["changelog-activity", eventFilter],
    queryFn: async () => {
      let query = supabase
        .from("changelog")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (eventFilter !== "all") {
        query = query.eq("event_type", eventFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Laden...</div>;

  return (
    <div className="space-y-4">
      {/* CSV Import Status per File Widget */}
      <CsvImportStatusWidget />

      {/* CSV Import Summary Cards */}
      {importSummary && importSummary.totalImports > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <FileSpreadsheet className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wider">Laatste CSV Import</span>
              </div>
              <p className="text-sm font-medium">
                {importSummary.lastImport
                  ? formatDistanceToNow(new Date(importSummary.lastImport.created_at), { addSuffix: true, locale: nl })
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {importSummary.totalImports} imports totaal
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Package className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wider">Producten</span>
              </div>
              <div className="flex items-center gap-3">
                <div>
                  <span className="text-lg font-semibold text-primary">{importSummary.totalNew}</span>
                  <span className="text-xs text-muted-foreground ml-1">nieuw</span>
                </div>
                <div>
                  <span className="text-lg font-semibold text-accent-foreground">{importSummary.totalUpdated}</span>
                  <span className="text-xs text-muted-foreground ml-1">bijgewerkt</span>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <TrendingUp className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wider">Varianten Nieuw</span>
              </div>
              <span className="text-lg font-semibold text-primary">{importSummary.totalVariantsNew}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <RefreshCw className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wider">Varianten Bijgewerkt</span>
              </div>
              <span className="text-lg font-semibold text-accent-foreground">{importSummary.totalVariantsUpdated}</span>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={eventFilter} onValueChange={setEventFilter}>
          <SelectTrigger className="w-[260px]">
            <SelectValue placeholder="Filter op event type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle events</SelectItem>
            {eventTypes.map(({ type, count }) => (
              <SelectItem key={type} value={type}>
                {type} ({count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-xl border border-border bg-muted/30 p-8 text-center">
          <Activity className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">Geen changelog entries</p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const meta = entry.metadata as Record<string, any> | null;
            const isImport = entry.event_type === 'PRODUCT_CSV_IMPORT' || entry.event_type === 'STOCK_CSV_IMPORT';
            const hasErrors = meta && ((meta.error_count || 0) > 0 || (meta.errors?.length || 0) > 0);
            const hasSkipped = meta && (meta.skipped_rows || 0) > 0;
            const zeroResults = isImport && meta && (
              entry.event_type === 'PRODUCT_CSV_IMPORT'
                ? (meta.productsInserted || 0) === 0 && (meta.productsUpdated || 0) === 0 && (meta.variantsInserted || 0) === 0 && (meta.variantsUpdated || 0) === 0
                : (meta.updated_variants || 0) === 0 && (meta.updated_prices || 0) === 0
            );
            const needsAttention = hasErrors || (isImport && zeroResults);

            const suggestedStep = hasErrors
              ? "Controleer het CSV-bestand op fouten en probeer opnieuw te uploaden."
              : zeroResults && hasSkipped
              ? `${meta?.skipped_rows} rijen overgeslagen — controleer of SKU's overeenkomen met de database.`
              : zeroResults
              ? "Geen wijzigingen gedetecteerd. Controleer of het bestand actuele data bevat."
              : hasSkipped
              ? `${meta?.skipped_rows} rijen overgeslagen — sommige SKU's zijn niet gevonden.`
              : null;

            return (
            <div key={entry.id} className={`flex items-start gap-3 px-4 py-3 rounded-lg border bg-card ${needsAttention ? 'border-destructive/40' : 'border-border'}`}>
              <div className="mt-0.5">
                <div className={`h-2 w-2 rounded-full ${needsAttention ? 'bg-destructive' : entry.event_type === 'PRODUCT_CSV_IMPORT' ? 'bg-primary' : 'bg-muted-foreground'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm">{entry.description}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <Badge variant={needsAttention ? 'destructive' : entry.event_type === 'PRODUCT_CSV_IMPORT' ? 'default' : 'secondary'} className="text-[11px]">{entry.event_type}</Badge>
                  {needsAttention && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="text-[11px] gap-1 border-destructive/40 text-destructive cursor-help">
                            <RotateCcw className="h-3 w-3" />
                            Retry nodig
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs">{suggestedStep}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {hasSkipped && !needsAttention && (
                    <Badge variant="outline" className="text-[11px] gap-1 text-muted-foreground">
                      {meta?.skipped_rows} overgeslagen
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(entry.created_at), "dd MMM yyyy HH:mm")}
                  </span>
                </div>
                {suggestedStep && needsAttention && (
                  <div className="flex items-start gap-1.5 mt-2 text-xs text-destructive bg-destructive/5 rounded-md px-2.5 py-1.5">
                    <Lightbulb className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{suggestedStep}</span>
                  </div>
                )}
              </div>
            </div>
            );
          })}

        </div>
      )}
    </div>
  );
}

export default ActivityPage;
