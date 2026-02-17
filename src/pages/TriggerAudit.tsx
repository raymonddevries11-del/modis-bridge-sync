import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  ShieldCheck, ShieldAlert, AlertTriangle, CheckCircle2,
  RefreshCw, Loader2, Database, Zap, ChevronDown, ChevronRight,
  Lock, Unlock, ArrowRight, Copy,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface TriggerInfo {
  trigger_name: string;
  table_name: string;
  schema_name: string;
  function_name: string;
  status: string;
  timing: string;
  events: string;
  level: string;
  writes_to_jobs: boolean;
  writes_to_pending: boolean;
  uses_idempotent_insert: boolean;
  uses_backpressure: boolean;
  function_source_preview: string | null;
}

interface DuplicateGroup {
  table: string;
  triggers: { name: string; function: string }[];
}

interface AuditData {
  triggers: TriggerInfo[];
  duplicates: {
    job_writers: DuplicateGroup[];
    pending_writers: DuplicateGroup[];
  };
  summary: {
    total: number;
    job_writers: number;
    pending_writers: number;
    duplicate_tables: number;
  };
}

const TriggerAudit = () => {
  const [expandedTrigger, setExpandedTrigger] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["trigger-audit"],
    queryFn: async (): Promise<AuditData> => {
      const { data, error } = await supabase.functions.invoke("trigger-audit");
      if (error) throw error;
      return data as AuditData;
    },
  });

  const hasDuplicates =
    (data?.duplicates.job_writers.length ?? 0) > 0 ||
    (data?.duplicates.pending_writers.length ?? 0) > 0;

  // Group triggers by table
  const byTable: Record<string, TriggerInfo[]> = {};
  for (const t of data?.triggers ?? []) {
    if (!byTable[t.table_name]) byTable[t.table_name] = [];
    byTable[t.table_name].push(t);
  }

  const toggleExpand = (name: string) =>
    setExpandedTrigger((prev) => (prev === name ? null : name));

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2">
              <Database className="h-6 w-6 text-primary" />
              Trigger Audit
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Overzicht van alle database triggers — detecteer duplicaten en beveiligingsproblemen.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5"
          >
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Herlaad
          </Button>
        </div>

        {/* Loading / Error */}
        {isLoading && (
          <Card className="card-elevated">
            <CardContent className="py-12 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Triggers ophalen uit database…</p>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="card-elevated border-destructive/30">
            <CardContent className="py-8 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-3" />
              <p className="text-sm text-destructive">{(error as Error).message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
                Opnieuw proberen
              </Button>
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            {/* Summary Cards */}
            <div className="grid gap-4 md:grid-cols-4">
              <SummaryCard
                icon={Database}
                label="Totaal triggers"
                value={data.summary.total}
                color="text-primary"
              />
              <SummaryCard
                icon={Zap}
                label="Schrijven naar jobs"
                value={data.summary.job_writers}
                color="text-warning"
              />
              <SummaryCard
                icon={ArrowRight}
                label="Schrijven naar pending"
                value={data.summary.pending_writers}
                color="text-muted-foreground"
              />
              <SummaryCard
                icon={data.summary.duplicate_tables > 0 ? ShieldAlert : ShieldCheck}
                label="Duplicaat-tabellen"
                value={data.summary.duplicate_tables}
                color={data.summary.duplicate_tables > 0 ? "text-destructive" : "text-success"}
              />
            </div>

            {/* Duplicate Alerts */}
            {hasDuplicates && (
              <Card className="card-elevated border-destructive/30 bg-destructive/5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2 text-destructive">
                    <ShieldAlert className="h-4 w-4" />
                    Duplicaat triggers gedetecteerd
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {data.duplicates.job_writers.map((dup) => (
                    <DuplicateAlert
                      key={`job-${dup.table}`}
                      table={dup.table}
                      triggers={dup.triggers}
                      target="jobs"
                    />
                  ))}
                  {data.duplicates.pending_writers.map((dup) => (
                    <DuplicateAlert
                      key={`pending-${dup.table}`}
                      table={dup.table}
                      triggers={dup.triggers}
                      target="pending_product_syncs"
                    />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* All clear */}
            {!hasDuplicates && (
              <Card className="card-elevated border-success/30 bg-success/5">
                <CardContent className="py-4 flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-success" />
                  <div>
                    <p className="text-sm font-medium text-success">Geen duplicaten gevonden</p>
                    <p className="text-xs text-muted-foreground">
                      Alle tabellen hebben maximaal één trigger die naar jobs of pending_product_syncs schrijft.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Trigger Table by Group */}
            <Card className="card-elevated">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Alle triggers per tabel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {Object.entries(byTable)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([tableName, triggers]) => (
                    <div
                      key={tableName}
                      className="rounded-lg border bg-card"
                    >
                      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/30 rounded-t-lg border-b">
                        <Database className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm font-medium">{tableName}</span>
                        <Badge variant="outline" className="ml-auto text-[10px]">
                          {triggers.length} trigger{triggers.length !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                      <div className="divide-y">
                        {triggers.map((trigger) => {
                          const isExpanded = expandedTrigger === trigger.trigger_name;
                          return (
                            <div key={trigger.trigger_name} className="px-4 py-2.5">
                              <div
                                className="flex items-center gap-2 cursor-pointer"
                                onClick={() => toggleExpand(trigger.trigger_name)}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <span className="text-sm font-mono">{trigger.trigger_name}</span>

                                <div className="flex items-center gap-1.5 ml-auto">
                                  {trigger.writes_to_jobs && (
                                    <Badge variant="outline" className="text-[10px] border-warning/50 text-warning">
                                      jobs
                                    </Badge>
                                  )}
                                  {trigger.writes_to_pending && (
                                    <Badge variant="outline" className="text-[10px] border-primary/50 text-primary">
                                      pending
                                    </Badge>
                                  )}
                                  {trigger.uses_idempotent_insert && (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger>
                                          <Lock className="h-3 w-3 text-success" />
                                        </TooltipTrigger>
                                        <TooltipContent>Idempotent insert (unique_violation handler)</TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )}
                                  {trigger.uses_backpressure && (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger>
                                          <ShieldCheck className="h-3 w-3 text-success" />
                                        </TooltipTrigger>
                                        <TooltipContent>Backpressure mechanisme</TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )}
                                  {trigger.writes_to_jobs && !trigger.uses_idempotent_insert && (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger>
                                          <Unlock className="h-3 w-3 text-destructive" />
                                        </TooltipTrigger>
                                        <TooltipContent>Geen idempotent insert — risico op duplicaten!</TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )}
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] ${
                                      trigger.status === "enabled"
                                        ? "border-success/50 text-success"
                                        : "border-destructive/50 text-destructive"
                                    }`}
                                  >
                                    {trigger.status}
                                  </Badge>
                                </div>
                              </div>

                              {/* Meta row */}
                              <div className="flex items-center gap-3 mt-1 ml-5 text-xs text-muted-foreground">
                                <span>{trigger.timing} {trigger.events}</span>
                                <span>→ {trigger.function_name}()</span>
                                <span>{trigger.level}</span>
                              </div>

                              {/* Expanded: function source preview */}
                              {isExpanded && trigger.function_source_preview && (
                                <div className="mt-2 ml-5 relative">
                                  <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-64 font-mono whitespace-pre-wrap">
                                    {trigger.function_source_preview}
                                    {trigger.function_source_preview.length >= 500 && "\n\n… (truncated)"}
                                  </pre>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="absolute top-1 right-1 h-6 w-6 p-0"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText(
                                        trigger.function_source_preview ?? "",
                                      );
                                      toast.success("Gekopieerd");
                                    }}
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </CardContent>
            </Card>

            {/* Best Practices */}
            <Card className="card-elevated">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Richtlijnen voor triggers
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  <GuidelineCard
                    icon={<Lock className="h-4 w-4 text-success" />}
                    title="Idempotent inserts"
                    description="Gebruik altijd EXCEPTION WHEN unique_violation THEN NULL bij INSERT INTO jobs."
                  />
                  <GuidelineCard
                    icon={<ShieldCheck className="h-4 w-4 text-success" />}
                    title="Backpressure"
                    description="Check queue_size voor INSERT — val terug op pending_product_syncs bij hoge load."
                  />
                  <GuidelineCard
                    icon={<AlertTriangle className="h-4 w-4 text-warning" />}
                    title="Eén trigger per tabel"
                    description="Nooit twee triggers op dezelfde tabel die naar jobs schrijven."
                  />
                  <GuidelineCard
                    icon={<Database className="h-4 w-4 text-primary" />}
                    title="Audit na elke wijziging"
                    description="Draai deze audit na het toevoegen of wijzigen van triggers."
                  />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </Layout>
  );
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <Card className="card-elevated">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <Icon className={`h-5 w-5 ${color}`} />
          <span className="text-2xl font-bold">{value}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </CardContent>
    </Card>
  );
}

function DuplicateAlert({
  table,
  triggers,
  target,
}: {
  table: string;
  triggers: { name: string; function: string }[];
  target: string;
}) {
  return (
    <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
      <p className="text-sm font-medium text-destructive">
        Tabel <code className="px-1 py-0.5 bg-destructive/10 rounded text-xs">{table}</code> heeft{" "}
        {triggers.length} triggers die naar <code className="px-1 py-0.5 bg-destructive/10 rounded text-xs">{target}</code> schrijven:
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {triggers.map((t) => (
          <li key={t.name} className="text-xs text-destructive/80 flex items-center gap-2">
            <span className="font-mono">{t.name}</span>
            <span className="text-muted-foreground">→ {t.function}()</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GuidelineCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
  );
}

export default TriggerAudit;
