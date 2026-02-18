import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { TenantSelector } from "@/components/TenantSelector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from "@/components/ui/tooltip";
import {
  AlertTriangle, ShieldAlert, XCircle, Clock, CheckCircle2,
  RefreshCw, TrendingUp, TrendingDown, BarChart3, Activity,
  Zap, Timer, ArrowUpRight, Minus,
} from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { nl } from "date-fns/locale";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Area, AreaChart,
} from "recharts";

function ago(d: string | null) {
  if (!d) return "—";
  return formatDistanceToNow(new Date(d), { addSuffix: true, locale: nl });
}

// ── Data hooks ───────────────────────────────────────────────

function useErrorStats(tenantId: string) {
  return useQuery({
    queryKey: ["error-dashboard-stats", tenantId],
    queryFn: async () => {
      const now = new Date();
      const h24 = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const h7d = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();

      const [errorJobs, allJobs24h, stuckJobs, escalated7d] = await Promise.all([
        supabase.from("jobs")
          .select("id, type, error, attempts, created_at, updated_at")
          .eq("state", "error")
          .order("updated_at", { ascending: false })
          .limit(200),
        supabase.from("jobs")
          .select("state", { count: "exact" })
          .gte("created_at", h24),
        supabase.from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("state", "processing")
          .lt("updated_at", new Date(now.getTime() - 15 * 60_000).toISOString()),
        supabase.from("changelog")
          .select("id", { count: "exact", head: true })
          .eq("event_type", "JOB_ESCALATED")
          .gte("created_at", h7d),
      ]);

      const errors = errorJobs.data || [];
      const total24h = allJobs24h.data?.length ?? 0;

      // Count by state for 24h
      const byState: Record<string, number> = {};
      for (const j of allJobs24h.data || []) {
        byState[j.state] = (byState[j.state] || 0) + 1;
      }

      return {
        errorJobs: errors,
        errorCount: errors.length,
        total24h,
        done24h: byState.done || 0,
        error24h: byState.error || 0,
        stuck: stuckJobs.count ?? 0,
        escalated7d: escalated7d.count ?? 0,
        successRate: total24h > 0 ? ((byState.done || 0) / total24h) * 100 : 100,
      };
    },
    enabled: !!tenantId,
    refetchInterval: 15_000,
  });
}

function useRetryAnalytics(tenantId: string) {
  return useQuery({
    queryKey: ["error-dashboard-retry-analytics", tenantId],
    queryFn: async () => {
      const h7d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

      // Changelog entries for retries and escalations
      const { data: retryEvents } = await supabase
        .from("changelog")
        .select("event_type, description, metadata, created_at")
        .eq("tenant_id", tenantId)
        .in("event_type", [
          "JOB_ESCALATED", "JOB_FAILED_PERMANENT",
          "WOO_PRODUCT_PUSH", "WOO_PRODUCT_UPDATED",
          "WOO_PRODUCT_CREATED", "AUTO_RETRY_FAILED_PUSH",
        ])
        .gte("created_at", h7d)
        .order("created_at", { ascending: false })
        .limit(500);

      // Monitor state
      const { data: monitorState } = await supabase
        .from("config")
        .select("value")
        .eq("key", "retry_monitor_state")
        .maybeSingle();

      return {
        events: retryEvents || [],
        monitorState: (monitorState?.value as any) ?? null,
      };
    },
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });
}

function useFailedPushStats(tenantId: string) {
  return useQuery({
    queryKey: ["error-dashboard-failed-pushes", tenantId],
    queryFn: async () => {
      const { data } = await supabase
        .from("woo_products")
        .select("id, last_push_changes, last_pushed_at")
        .eq("tenant_id", tenantId)
        .not("last_push_changes", "is", null)
        .limit(500);

      const failed = (data || []).filter((p: any) => {
        const lpc = p.last_push_changes as any;
        if (!lpc) return false;
        if (lpc.action === "error") return true;
        if (typeof lpc.message === "string" &&
          /error|blocked|failed|bot protection/i.test(lpc.message)) return true;
        return false;
      });

      // Categorize errors
      const categories: Record<string, number> = {
        "Bot Protection": 0,
        "Validatie (400)": 0,
        "Timeout": 0,
        "Auth (401/403)": 0,
        "Overig": 0,
      };

      for (const p of failed) {
        const lpc = p.last_push_changes as any;
        const msg = (lpc?.message || "").toLowerCase();
        if (/bot protection|blocked|html/i.test(msg)) categories["Bot Protection"]++;
        else if (/400|invalid/i.test(msg)) categories["Validatie (400)"]++;
        else if (/timeout|504|fetch/i.test(msg)) categories["Timeout"]++;
        else if (/401|403|unauthorized/i.test(msg)) categories["Auth (401/403)"]++;
        else categories["Overig"]++;
      }

      return { total: failed.length, categories };
    },
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });
}

// ── Components ───────────────────────────────────────────────

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

function ErrorCategoryPie({ categories }: { categories: Record<string, number> }) {
  const data = Object.entries(categories)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }));

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
        <CheckCircle2 className="h-5 w-5 mr-2 text-success" />
        Geen fouten
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={3}
          dataKey="value"
          label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
          labelLine={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

function RetryTimeline({ events }: { events: any[] }) {
  // Group events by day
  const byDay = useMemo(() => {
    const map = new Map<string, { date: string; retries: number; successes: number; escalations: number }>();
    for (const e of events) {
      const day = e.created_at.substring(0, 10);
      if (!map.has(day)) map.set(day, { date: day, retries: 0, successes: 0, escalations: 0 });
      const entry = map.get(day)!;
      if (e.event_type === "AUTO_RETRY_FAILED_PUSH") entry.retries++;
      else if (e.event_type === "WOO_PRODUCT_UPDATED" || e.event_type === "WOO_PRODUCT_CREATED") entry.successes++;
      else if (e.event_type === "JOB_ESCALATED" || e.event_type === "JOB_FAILED_PERMANENT") entry.escalations++;
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [events]);

  if (byDay.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
        Geen data in de afgelopen 7 dagen
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={byDay}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <Area type="monotone" dataKey="successes" stackId="1" fill="hsl(var(--chart-1))" stroke="hsl(var(--chart-1))" fillOpacity={0.4} name="Succesvol" />
        <Area type="monotone" dataKey="retries" stackId="1" fill="hsl(var(--chart-3))" stroke="hsl(var(--chart-3))" fillOpacity={0.4} name="Retries" />
        <Area type="monotone" dataKey="escalations" stackId="1" fill="hsl(var(--chart-5))" stroke="hsl(var(--chart-5))" fillOpacity={0.4} name="Escalaties" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ErrorAttemptDistribution({ errors }: { errors: any[] }) {
  const distribution = useMemo(() => {
    const map = new Map<number, number>();
    for (const e of errors) {
      const a = e.attempts || 0;
      map.set(a, (map.get(a) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([attempts, count]) => ({ attempts: `${attempts}x`, count }));
  }, [errors]);

  if (distribution.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={distribution}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="attempts" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} name="Jobs" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function RecentErrorList({ errors }: { errors: any[] }) {
  if (errors.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        <CheckCircle2 className="h-5 w-5 mr-2 text-success" />
        Geen recente fouten
      </div>
    );
  }

  const getErrorIcon = (error: string | null) => {
    if (!error) return AlertTriangle;
    const e = error.toLowerCase();
    if (/bot|blocked|html/i.test(e)) return ShieldAlert;
    if (/timeout|504/i.test(e)) return Clock;
    if (/401|403/i.test(e)) return XCircle;
    return AlertTriangle;
  };

  return (
    <div className="space-y-2 max-h-[400px] overflow-y-auto">
      {errors.slice(0, 20).map((job) => {
        const Icon = getErrorIcon(job.error);
        return (
          <div key={job.id} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
            <Icon className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground">{job.type}</span>
                <Badge variant="outline" className="text-[10px]">
                  {job.attempts}x geprobeerd
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {job.error || "Onbekende fout"}
              </p>
            </div>
            <span className="text-[10px] text-muted-foreground flex-shrink-0 whitespace-nowrap">
              {ago(job.updated_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────

export default function ErrorDashboard() {
  const [selectedTenant, setSelectedTenant] = useState("");

  const { data: tenants } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("*").eq("active", true).order("name");
      return data || [];
    },
  });

  useEffect(() => {
    if (tenants?.length && !selectedTenant) setSelectedTenant(tenants[0].id);
  }, [tenants, selectedTenant]);

  const { data: stats } = useErrorStats(selectedTenant);
  const { data: retryData } = useRetryAnalytics(selectedTenant);
  const { data: pushStats } = useFailedPushStats(selectedTenant);

  const retrySuccessRate = useMemo(() => {
    if (!retryData?.events.length) return null;
    const retries = retryData.events.filter(e => e.event_type === "AUTO_RETRY_FAILED_PUSH").length;
    const escalated = retryData.events.filter(e =>
      e.event_type === "JOB_ESCALATED" || e.event_type === "JOB_FAILED_PERMANENT"
    ).length;
    if (retries + escalated === 0) return null;
    return ((retries / (retries + escalated)) * 100);
  }, [retryData]);

  return (
    <Layout>
      <TooltipProvider>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-3">
                <AlertTriangle className="h-6 w-6 text-destructive" />
                Error Dashboard
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Foutanalyse, retry-statistieken en escalatie-overzicht
              </p>
            </div>
            <TenantSelector value={selectedTenant} onChange={setSelectedTenant} />
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard
              label="Succes ratio (24u)"
              value={`${(stats?.successRate ?? 100).toFixed(1)}%`}
              icon={stats?.successRate && stats.successRate >= 95 ? TrendingUp : TrendingDown}
              color={stats?.successRate && stats.successRate >= 95 ? "text-success" : "text-destructive"}
              sub={`${stats?.done24h ?? 0} gelukt / ${stats?.total24h ?? 0} totaal`}
            />
            <KpiCard
              label="Actieve fouten"
              value={stats?.errorCount ?? 0}
              icon={XCircle}
              color={stats?.errorCount ? "text-destructive" : "text-success"}
              sub={`${stats?.stuck ?? 0} vastgelopen`}
            />
            <KpiCard
              label="Mislukte pushes"
              value={pushStats?.total ?? 0}
              icon={ShieldAlert}
              color={pushStats?.total ? "text-warning" : "text-success"}
              sub={`${Object.values(pushStats?.categories ?? {}).reduce((a, b) => a + b, 0)} gecategoriseerd`}
            />
            <KpiCard
              label="Escalaties (7d)"
              value={stats?.escalated7d ?? 0}
              icon={Zap}
              color={stats?.escalated7d ? "text-destructive" : "text-success"}
              sub={retrySuccessRate !== null ? `Retry succes: ${retrySuccessRate.toFixed(0)}%` : "Geen retries"}
            />
          </div>

          {/* Main content tabs */}
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overzicht</TabsTrigger>
              <TabsTrigger value="timeline">Retry Tijdlijn</TabsTrigger>
              <TabsTrigger value="errors">Recente Fouten</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-6 mt-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Error categories pie */}
                <Card className="card-elevated">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-primary" />
                      Foutcategorieën (WooCommerce pushes)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ErrorCategoryPie categories={pushStats?.categories ?? {}} />
                    {pushStats && Object.entries(pushStats.categories).some(([, v]) => v > 0) && (
                      <div className="mt-3 space-y-1.5">
                        {Object.entries(pushStats.categories)
                          .filter(([, v]) => v > 0)
                          .sort((a, b) => b[1] - a[1])
                          .map(([cat, count], i) => (
                            <div key={cat} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 rounded-full"
                                  style={{ backgroundColor: COLORS[i % COLORS.length] }}
                                />
                                <span className="text-muted-foreground">{cat}</span>
                              </div>
                              <span className="font-medium">{count}</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Attempt distribution */}
                <Card className="card-elevated">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <RefreshCw className="h-4 w-4 text-primary" />
                      Pogingen per fout-job
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ErrorAttemptDistribution errors={stats?.errorJobs ?? []} />
                    {stats && stats.errorJobs.length > 0 && (
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="rounded-lg bg-muted/50 p-3 text-center">
                          <p className="text-lg font-bold">
                            {(stats.errorJobs.reduce((s, j) => s + (j.attempts || 0), 0) / stats.errorJobs.length).toFixed(1)}
                          </p>
                          <p className="text-[10px] text-muted-foreground">Gem. pogingen</p>
                        </div>
                        <div className="rounded-lg bg-muted/50 p-3 text-center">
                          <p className="text-lg font-bold">
                            {Math.max(...stats.errorJobs.map(j => j.attempts || 0))}
                          </p>
                          <p className="text-[10px] text-muted-foreground">Max pogingen</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Retry monitor state */}
                <Card className="card-elevated">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Activity className="h-4 w-4 text-primary" />
                      Retry Monitor Status
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {retryData?.monitorState ? (
                      <>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="rounded-lg bg-muted/50 p-2">
                            <p className="text-lg font-bold">{retryData.monitorState.retried ?? 0}</p>
                            <p className="text-[10px] text-muted-foreground">Herstart</p>
                          </div>
                          <div className="rounded-lg bg-muted/50 p-2">
                            <p className="text-lg font-bold">{retryData.monitorState.escalated ?? 0}</p>
                            <p className="text-[10px] text-muted-foreground">Geëscaleerd</p>
                          </div>
                          <div className="rounded-lg bg-muted/50 p-2">
                            <p className="text-lg font-bold">{retryData.monitorState.stuck_found ?? 0}</p>
                            <p className="text-[10px] text-muted-foreground">Stuck gevonden</p>
                          </div>
                        </div>
                        {retryData.monitorState.last_run && (
                          <p className="text-xs text-muted-foreground text-center">
                            Laatste scan: {ago(retryData.monitorState.last_run)}
                          </p>
                        )}
                        {retryData.monitorState.actions?.length > 0 && (
                          <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                            {retryData.monitorState.actions.slice(0, 8).map((action: any, i: number) => (
                              <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded-md px-2.5 py-1.5">
                                {action.action === "escalated" ? (
                                  <ShieldAlert className="h-3 w-3 text-destructive" />
                                ) : (
                                  <RefreshCw className="h-3 w-3 text-primary" />
                                )}
                                <span className="font-medium truncate flex-1">
                                  {action.type?.replace(/_/g, " ")}
                                </span>
                                <span className="text-muted-foreground truncate max-w-[120px]">
                                  {action.reason}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-center py-6 text-muted-foreground text-sm">
                        <Timer className="h-5 w-5 mx-auto mb-2 opacity-50" />
                        Monitor nog niet gedraaid
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Error type breakdown from jobs */}
                <Card className="card-elevated">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Zap className="h-4 w-4 text-primary" />
                      Fouten per job-type
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <JobTypeBreakdown errors={stats?.errorJobs ?? []} />
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="timeline" className="mt-4">
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Retry & Escalatie Tijdlijn (7 dagen)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RetryTimeline events={retryData?.events ?? []} />
                  <div className="flex items-center justify-center gap-6 mt-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "hsl(var(--chart-1))" }} />
                      Succesvol
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "hsl(var(--chart-3))" }} />
                      Retries
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "hsl(var(--chart-5))" }} />
                      Escalaties
                    </span>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="errors" className="mt-4">
              <Card className="card-elevated">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-destructive" />
                    Recente Fouten
                    {stats?.errorCount ? (
                      <Badge variant="destructive" className="ml-auto text-[10px]">
                        {stats.errorCount}
                      </Badge>
                    ) : null}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RecentErrorList errors={stats?.errorJobs ?? []} />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </TooltipProvider>
    </Layout>
  );
}

// ── Small components ─────────────────────────────────────────

function KpiCard({ label, value, icon: Icon, color, sub }: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
  sub: string;
}) {
  return (
    <Card className="card-elevated">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Icon className={`h-4 w-4 ${color}`} />
        </div>
        <p className={`text-2xl font-bold ${color}`}>{value}</p>
        <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}

function JobTypeBreakdown({ errors }: { errors: any[] }) {
  const byType = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of errors) {
      map.set(e.type, (map.get(e.type) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));
  }, [errors]);

  if (byType.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground text-sm">
        <CheckCircle2 className="h-5 w-5 mx-auto mb-2 text-success" />
        Geen fout-jobs
      </div>
    );
  }

  const maxCount = Math.max(...byType.map(b => b.count));

  return (
    <div className="space-y-2">
      {byType.map(({ type, count }) => (
        <div key={type} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-mono text-xs text-muted-foreground">{type.replace(/_/g, " ")}</span>
            <span className="font-medium">{count}</span>
          </div>
          <Progress value={(count / maxCount) * 100} className="h-1.5" />
        </div>
      ))}
    </div>
  );
}
