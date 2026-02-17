import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  HeartPulse, Clock, CheckCircle2, AlertCircle, RefreshCw,
  ArrowDownToLine, ArrowUpFromLine, Image, Activity, Database,
  Gauge, ShieldAlert, TrendingUp, TrendingDown, Minus, Box,
  Zap, Timer, FileText,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { nl } from "date-fns/locale";

// ─── Helpers ───
function ago(dateStr: string | null | undefined) {
  if (!dateStr) return "—";
  return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: nl });
}

type Status = "healthy" | "warning" | "critical" | "unknown";

function statusColor(s: Status) {
  return s === "healthy"
    ? "text-emerald-500"
    : s === "warning"
      ? "text-amber-500"
      : s === "critical"
        ? "text-red-500"
        : "text-muted-foreground";
}

function statusBg(s: Status) {
  return s === "healthy"
    ? "bg-emerald-500/10 border-emerald-500/30"
    : s === "warning"
      ? "bg-amber-500/10 border-amber-500/30"
      : s === "critical"
        ? "bg-red-500/10 border-red-500/30"
        : "bg-muted/50 border-border";
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${
      status === "healthy" ? "bg-emerald-500" :
      status === "warning" ? "bg-amber-500" :
      status === "critical" ? "bg-red-500" : "bg-muted-foreground"
    }`} />
  );
}

// ─── Data hooks ───

function useJobQueue() {
  return useQuery({
    queryKey: ["pipeline-health-jobs"],
    queryFn: async () => {
      const [allJobs, stuckJobs, pendingSyncs, oldestReady] = await Promise.all([
        supabase.from("jobs").select("state, type, attempts, created_at, updated_at"),
        supabase.from("jobs").select("id", { count: "exact", head: true })
          .eq("state", "processing")
          .lt("updated_at", new Date(Date.now() - 15 * 60_000).toISOString()),
        supabase.from("pending_product_syncs").select("reason, created_at"),
        supabase.from("jobs").select("created_at").eq("state", "ready")
          .order("created_at", { ascending: true }).limit(1),
      ]);
      const jobs = allJobs.data || [];
      const byState: Record<string, number> = {};
      const byType: Record<string, number> = {};
      for (const j of jobs) {
        byState[j.state] = (byState[j.state] || 0) + 1;
        if (j.state === "ready" || j.state === "processing") {
          byType[j.type] = (byType[j.type] || 0) + 1;
        }
      }

      const pending = pendingSyncs.data || [];
      const pendingByReason: Record<string, number> = {};
      for (const p of pending) pendingByReason[p.reason] = (pendingByReason[p.reason] || 0) + 1;

      return {
        ready: byState.ready || 0,
        processing: byState.processing || 0,
        done: byState.done || 0,
        error: byState.error || 0,
        total: jobs.length,
        stuck: stuckJobs.count ?? 0,
        byType,
        pending: pending.length,
        pendingByReason,
        oldestReady: oldestReady.data?.[0]?.created_at ?? null,
      };
    },
    refetchInterval: 10_000,
  });
}

function useCronHealth() {
  return useQuery({
    queryKey: ["pipeline-health-cron"],
    queryFn: async () => {
      // Get recent changelog entries for automated jobs
      const { data: events } = await supabase
        .from("changelog")
        .select("event_type, created_at, metadata, description")
        .in("event_type", [
          "AUTO_IMAGE_FIX", "AUTO_IMAGE_FIX_NOOP",
          "BULK_IMAGE_REFRESH", "SFTP_SCAN",
          "WOO_SYNC_BATCH", "WOO_SYNC_COMPLETE",
          "HOUSEKEEP_JOBS", "JOB_FAILED_PERMANENT",
          "STOCK_IMPORT", "STOCK_FULL_IMPORT",
          "CSV_IMPORT", "ARTICLE_IMPORT",
        ])
        .order("created_at", { ascending: false })
        .limit(30);

      // Group by event type to find last occurrence
      const lastByType: Record<string, { at: string; meta: any; desc: string }> = {};
      for (const e of events || []) {
        if (!lastByType[e.event_type]) {
          lastByType[e.event_type] = { at: e.created_at, meta: e.metadata, desc: e.description };
        }
      }
      return { lastByType, recentEvents: (events || []).slice(0, 12) };
    },
    refetchInterval: 30_000,
  });
}

function useImageHealth() {
  return useQuery({
    queryKey: ["pipeline-health-images"],
    queryFn: async () => {
      const { data } = await supabase.rpc("validate_no_duplicate_triggers" as any);
      // Count images by type
      const [total, legacy, noImages] = await Promise.all([
        supabase.from("products").select("id", { count: "exact", head: true }).not("images", "is", null),
        supabase.from("products").select("id", { count: "exact", head: true }).ilike("images", "%modis/foto%"),
        supabase.from("products").select("id", { count: "exact", head: true }).or("images.is.null,images.eq.[]"),
      ]);
      return {
        withImages: total.count ?? 0,
        legacyPaths: legacy.count ?? 0,
        noImages: noImages.count ?? 0,
      };
    },
    refetchInterval: 60_000,
  });
}

function useCircuitBreaker() {
  return useQuery({
    queryKey: ["pipeline-health-circuit-breaker"],
    queryFn: async () => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", "woo_circuit_breaker")
        .maybeSingle();
      return data?.value as any ?? null;
    },
    refetchInterval: 15_000,
  });
}

function useWooSyncStats() {
  return useQuery({
    queryKey: ["pipeline-health-woo-stats"],
    queryFn: async () => {
      const now = new Date();
      const h24 = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const [synced24h, totalLinked, unlinked] = await Promise.all([
        supabase.from("woo_products").select("id", { count: "exact", head: true })
          .gt("last_pushed_at", h24),
        supabase.from("woo_products").select("id", { count: "exact", head: true })
          .not("product_id", "is", null),
        supabase.from("woo_products").select("id", { count: "exact", head: true })
          .is("product_id", null),
      ]);
      return {
        syncedLast24h: synced24h.count ?? 0,
        totalLinked: totalLinked.count ?? 0,
        unlinked: unlinked.count ?? 0,
      };
    },
    refetchInterval: 30_000,
  });
}

// ─── Page ───

export default function PipelineHealth() {
  const { data: jobs } = useJobQueue();
  const { data: cron } = useCronHealth();
  const { data: images } = useImageHealth();
  const { data: cb } = useCircuitBreaker();
  const { data: woo } = useWooSyncStats();

  // Derive overall status
  const queueStatus: Status =
    !jobs ? "unknown"
    : jobs.stuck > 0 || jobs.error > 10 ? "critical"
    : jobs.ready > 50 || jobs.error > 3 ? "warning"
    : "healthy";

  const cbStatus: Status =
    !cb ? "unknown" : cb.tripped ? "critical" : "healthy";

  const imageStatus: Status =
    !images ? "unknown"
    : images.legacyPaths > 50 ? "warning"
    : images.legacyPaths > 0 ? "warning"
    : "healthy";

  const overallStatus: Status =
    queueStatus === "critical" || cbStatus === "critical" ? "critical"
    : queueStatus === "warning" || imageStatus === "warning" ? "warning"
    : "healthy";

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3">
              <HeartPulse className="h-6 w-6 text-primary" />
              Pipeline Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Modis → PIM → WooCommerce sync pipeline status
            </p>
          </div>
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full border ${statusBg(overallStatus)}`}>
            <StatusDot status={overallStatus} />
            <span className={`text-sm font-semibold ${statusColor(overallStatus)}`}>
              {overallStatus === "healthy" ? "Alles OK" :
               overallStatus === "warning" ? "Aandacht nodig" :
               overallStatus === "critical" ? "Kritiek" : "Laden..."}
            </span>
          </div>
        </div>

        {/* Pipeline flow overview */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <PipelineStage
            icon={ArrowDownToLine}
            title="SFTP Inbound"
            subtitle="Modis bestanden"
            lastRun={cron?.lastByType?.SFTP_SCAN?.at || cron?.lastByType?.ARTICLE_IMPORT?.at || cron?.lastByType?.STOCK_FULL_IMPORT?.at}
            status={cron?.lastByType?.SFTP_SCAN ? "healthy" : "unknown"}
          />
          <PipelineStage
            icon={Database}
            title="PIM Import"
            subtitle="Artikelen & voorraad"
            lastRun={cron?.lastByType?.ARTICLE_IMPORT?.at || cron?.lastByType?.CSV_IMPORT?.at || cron?.lastByType?.STOCK_FULL_IMPORT?.at}
            status="healthy"
          />
          <PipelineStage
            icon={Zap}
            title="Job Queue"
            subtitle={`${jobs?.ready ?? 0} wachtend · ${jobs?.processing ?? 0} actief`}
            lastRun={null}
            status={queueStatus}
            badge={jobs && jobs.ready + jobs.processing > 0 ? `${jobs.ready + jobs.processing}` : undefined}
          />
          <PipelineStage
            icon={ArrowUpFromLine}
            title="WooCommerce Push"
            subtitle={`${woo?.syncedLast24h ?? 0} in 24u`}
            lastRun={cron?.lastByType?.WOO_SYNC_COMPLETE?.at || cron?.lastByType?.WOO_SYNC_BATCH?.at}
            status={cbStatus === "critical" ? "critical" : "healthy"}
          />
          <PipelineStage
            icon={Image}
            title="Image Sync"
            subtitle={`${images?.legacyPaths ?? 0} legacy`}
            lastRun={cron?.lastByType?.AUTO_IMAGE_FIX?.at || cron?.lastByType?.AUTO_IMAGE_FIX_NOOP?.at}
            status={imageStatus}
          />
        </div>

        {/* Detail cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Job Queue Detail */}
          <Card className="card-elevated">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Gauge className="h-4 w-4 text-primary" />
                Job Queue
                <Badge variant="outline" className={`ml-auto text-[10px] ${
                  queueStatus === "healthy" ? "border-emerald-500/50 text-emerald-500" :
                  queueStatus === "warning" ? "border-amber-500/50 text-amber-500" :
                  "border-red-500/50 text-red-500"
                }`}>
                  {queueStatus}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-4 gap-2">
                <MiniStat icon={Clock} label="Ready" value={jobs?.ready ?? 0} color="text-muted-foreground" />
                <MiniStat icon={RefreshCw} label="Active" value={jobs?.processing ?? 0} color="text-primary" />
                <MiniStat icon={CheckCircle2} label="Done" value={jobs?.done ?? 0} color="text-emerald-500" />
                <MiniStat icon={AlertCircle} label="Error" value={jobs?.error ?? 0} color="text-red-500" />
              </div>

              {/* Queue breakdown by type */}
              {jobs && Object.keys(jobs.byType).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Wachtend per type</p>
                  {Object.entries(jobs.byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground font-mono text-xs">{type}</span>
                      <span className="font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Stuck jobs alert */}
              {(jobs?.stuck ?? 0) > 0 && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm">
                  <ShieldAlert className="h-4 w-4 text-red-500 flex-shrink-0" />
                  <span className="text-red-500 font-medium">{jobs!.stuck} vastgelopen job(s) (&gt;15 min processing)</span>
                </div>
              )}

              {/* Pending syncs backlog */}
              {jobs && jobs.pending > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Pending syncs (overflow)</p>
                  <div className="flex items-center gap-2 text-sm">
                    <Timer className="h-3.5 w-3.5 text-amber-500" />
                    <span>{jobs.pending} producten wachten op sync</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(jobs.pendingByReason).map(([reason, count]) => (
                      <Badge key={reason} variant="secondary" className="text-[10px]">
                        {reason}: {count}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Oldest ready */}
              {jobs?.oldestReady && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Oudste wachtende job</span>
                  <span className="font-medium">{ago(jobs.oldestReady)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* WooCommerce Sync */}
          <Card className="card-elevated">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowUpFromLine className="h-4 w-4 text-primary" />
                WooCommerce Sync
                {cbStatus === "critical" && (
                  <Badge variant="destructive" className="ml-auto text-[10px]">
                    Circuit Breaker OPEN
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <MiniStat icon={TrendingUp} label="Pushed 24u" value={woo?.syncedLast24h ?? 0} color="text-emerald-500" />
                <MiniStat icon={Box} label="Gelinkt" value={woo?.totalLinked ?? 0} color="text-primary" />
                <MiniStat icon={AlertCircle} label="Ongelinkt" value={woo?.unlinked ?? 0} color="text-amber-500" />
              </div>

              {/* Circuit breaker detail */}
              {cb && (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Circuit breaker</span>
                    <span className={`font-medium ${cb.tripped ? "text-red-500" : "text-emerald-500"}`}>
                      {cb.tripped ? "OPEN (geblokkeerd)" : "Gesloten (OK)"}
                    </span>
                  </div>
                  {cb.consecutive_blocks > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Opeenvolgende blocks</span>
                      <span className="font-medium text-amber-500">{cb.consecutive_blocks}</span>
                    </div>
                  )}
                  {cb.tripped_at && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Geblokkeerd sinds</span>
                      <span className="font-medium">{ago(cb.tripped_at)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Link coverage */}
              {woo && woo.totalLinked + woo.unlinked > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>PIM-WooCommerce link coverage</span>
                    <span>{Math.round((woo.totalLinked / (woo.totalLinked + woo.unlinked)) * 100)}%</span>
                  </div>
                  <Progress
                    value={(woo.totalLinked / (woo.totalLinked + woo.unlinked)) * 100}
                    className="h-2"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Image Health */}
          <Card className="card-elevated">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Image className="h-4 w-4 text-primary" />
                Image URLs
                <Badge variant="outline" className={`ml-auto text-[10px] ${
                  imageStatus === "healthy" ? "border-emerald-500/50 text-emerald-500" :
                  "border-amber-500/50 text-amber-500"
                }`}>
                  {images?.legacyPaths ?? 0} legacy
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {images && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <MiniStat icon={CheckCircle2} label="OK" value={images.withImages - images.legacyPaths} color="text-emerald-500" />
                    <MiniStat icon={AlertCircle} label="Legacy" value={images.legacyPaths} color="text-amber-500" />
                    <MiniStat icon={Minus} label="Geen" value={images.noImages} color="text-muted-foreground" />
                  </div>

                  {images.withImages > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Migratie voortgang</span>
                        <span>{Math.round(((images.withImages - images.legacyPaths) / images.withImages) * 100)}%</span>
                      </div>
                      <Progress
                        value={((images.withImages - images.legacyPaths) / images.withImages) * 100}
                        className="h-2"
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Laatste auto-fix</span>
                    <span className="font-medium">
                      {ago(cron?.lastByType?.AUTO_IMAGE_FIX?.at || cron?.lastByType?.AUTO_IMAGE_FIX_NOOP?.at)}
                    </span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Recent Pipeline Events */}
          <Card className="card-elevated">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                Recente pipeline events
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[280px] overflow-y-auto">
                {cron?.recentEvents?.map((event, i) => (
                  <TooltipProvider key={i}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-3 text-sm cursor-help py-1.5 border-b border-border/50 last:border-0">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-[11px] text-primary">{event.event_type}</span>
                            <p className="text-xs text-muted-foreground truncate">{event.description}</p>
                          </div>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                            {ago(event.created_at)}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-sm text-xs">
                        <pre className="whitespace-pre-wrap">{JSON.stringify(event.metadata, null, 2)?.slice(0, 500)}</pre>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ))}
                {(!cron?.recentEvents || cron.recentEvents.length === 0) && (
                  <p className="text-sm text-muted-foreground py-4 text-center">Geen recente events</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}

// ─── Sub-components ───

function PipelineStage({
  icon: Icon, title, subtitle, lastRun, status, badge,
}: {
  icon: typeof Clock;
  title: string;
  subtitle: string;
  lastRun: string | null | undefined;
  status: Status;
  badge?: string;
}) {
  return (
    <div className={`relative rounded-xl border p-4 text-center space-y-1.5 ${statusBg(status)}`}>
      <Icon className={`h-5 w-5 mx-auto ${statusColor(status)}`} />
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      {lastRun && (
        <p className="text-[10px] text-muted-foreground">{ago(lastRun)}</p>
      )}
      {badge && (
        <Badge variant="secondary" className="absolute -top-2 -right-2 text-[10px] px-1.5">
          {badge}
        </Badge>
      )}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, color }: {
  icon: typeof Clock; label: string; value: number; color: string;
}) {
  return (
    <div className="text-center rounded-lg bg-muted/50 p-2.5">
      <Icon className={`h-4 w-4 mx-auto mb-1 ${color}`} />
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
