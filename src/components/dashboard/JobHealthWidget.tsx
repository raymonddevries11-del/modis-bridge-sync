import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  Gauge, CheckCircle2, Clock, AlertCircle, RefreshCw,
  TrendingUp, TrendingDown, Minus, Trash2, ShieldAlert,
} from "lucide-react";

interface QueueHealthState {
  alert_active: boolean;
  grace_started_at: string | null;
  queue_size: number;
  threshold: number;
  scaled_batch_size?: number;
}

interface JobStats {
  ready: number;
  processing: number;
  done: number;
  error: number;
  total: number;
  stuckCount: number;
  avgAttempts: number;
  oldestReadyAge: string | null;
}

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}u`;
  return `${Math.floor(hours / 24)}d`;
}

export const JobHealthWidget = () => {
  // Job stats
  const { data: jobStats } = useQuery({
    queryKey: ["job-health-stats"],
    queryFn: async (): Promise<JobStats> => {
      const [allJobs, stuckJobs, oldestReady] = await Promise.all([
        supabase.from("jobs").select("state, attempts"),
        supabase
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("state", "processing")
          .lt("updated_at", new Date(Date.now() - 15 * 60 * 1000).toISOString()),
        supabase
          .from("jobs")
          .select("created_at")
          .eq("state", "ready")
          .order("created_at", { ascending: true })
          .limit(1),
      ]);

      const jobs = allJobs.data || [];
      const byState = jobs.reduce(
        (acc, j) => {
          acc[j.state] = (acc[j.state] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const totalAttempts = jobs.reduce((sum, j) => sum + (j.attempts || 0), 0);

      return {
        ready: byState.ready || 0,
        processing: byState.processing || 0,
        done: byState.done || 0,
        error: byState.error || 0,
        total: jobs.length,
        stuckCount: stuckJobs.count ?? 0,
        avgAttempts: jobs.length ? +(totalAttempts / jobs.length).toFixed(1) : 0,
        oldestReadyAge: oldestReady.data?.[0]?.created_at ?? null,
      };
    },
    refetchInterval: 10000,
  });

  // Queue health / scaling state
  const { data: queueHealth } = useQuery({
    queryKey: ["job-health-queue-state"],
    queryFn: async (): Promise<QueueHealthState | null> => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", "job_queue_health")
        .maybeSingle();
      return (data?.value as unknown as QueueHealthState) ?? null;
    },
    refetchInterval: 10000,
  });

  // Housekeeping history from changelog
  const { data: lastHousekeep } = useQuery({
    queryKey: ["job-health-housekeep"],
    queryFn: async () => {
      const { data } = await supabase
        .from("changelog")
        .select("created_at, metadata")
        .in("event_type", ["HOUSEKEEP_JOBS", "JOB_FAILED_PERMANENT"])
        .order("created_at", { ascending: false })
        .limit(5);
      return data ?? [];
    },
    refetchInterval: 30000,
  });

  const stats = jobStats;
  const isScaling = queueHealth?.alert_active || (queueHealth?.grace_started_at && !queueHealth?.alert_active);
  const queueTrend =
    stats && queueHealth
      ? stats.ready + stats.processing > queueHealth.threshold
        ? "up"
        : stats.ready + stats.processing > queueHealth.threshold * 0.5
          ? "flat"
          : "down"
      : "flat";

  const TrendIcon = queueTrend === "up" ? TrendingUp : queueTrend === "down" ? TrendingDown : Minus;
  const trendColor = queueTrend === "up" ? "text-destructive" : queueTrend === "down" ? "text-success" : "text-muted-foreground";

  return (
    <Card className="card-elevated">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" />
          Job Health & Cleanup
          {isScaling && (
            <Badge variant="outline" className="ml-auto text-[10px] border-warning/50 text-warning">
              Auto-scaling actief
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* State breakdown */}
        <div className="grid grid-cols-4 gap-2">
          <StatCell icon={Clock} label="Ready" value={stats?.ready ?? 0} color="text-muted-foreground" />
          <StatCell icon={RefreshCw} label="Processing" value={stats?.processing ?? 0} color="text-primary" spinning={!!stats?.processing} />
          <StatCell icon={CheckCircle2} label="Done" value={stats?.done ?? 0} color="text-success" />
          <StatCell icon={AlertCircle} label="Error" value={stats?.error ?? 0} color="text-destructive" />
        </div>

        {/* Health indicators */}
        <div className="space-y-2 text-sm">
          {/* Queue trend */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Wachtrij trend</span>
            <span className={`flex items-center gap-1 font-medium ${trendColor}`}>
              <TrendIcon className="h-3.5 w-3.5" />
              {queueTrend === "up" ? "Groeiend" : queueTrend === "down" ? "Dalend" : "Stabiel"}
            </span>
          </div>

          {/* Stuck jobs */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Vastgelopen jobs</span>
            <span className={`font-medium ${(stats?.stuckCount ?? 0) > 0 ? "text-destructive" : "text-success"}`}>
              {stats?.stuckCount ?? 0}
              {(stats?.stuckCount ?? 0) > 0 && <ShieldAlert className="h-3 w-3 inline ml-1" />}
            </span>
          </div>

          {/* Avg attempts */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Gem. pogingen</span>
            <span className="font-medium">{stats?.avgAttempts ?? 0}</span>
          </div>

          {/* Oldest ready job */}
          {stats?.oldestReadyAge && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Oudste wachtende</span>
              <span className={`font-medium ${formatAge(stats.oldestReadyAge).includes("d") ? "text-warning" : ""}`}>
                {formatAge(stats.oldestReadyAge)} oud
              </span>
            </div>
          )}

          {/* Scaling info */}
          {queueHealth && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Batch size</span>
              <span className="font-medium">
                {isScaling ? (
                  <span className="text-warning">{queueHealth.scaled_batch_size ?? 15} (opgeschaald)</span>
                ) : (
                  "5 (normaal)"
                )}
              </span>
            </div>
          )}
        </div>

        {/* Recent housekeeping / permanent failures */}
        {lastHousekeep && lastHousekeep.length > 0 && (
          <div className="border-t pt-3 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Trash2 className="h-3 w-3" /> Recente cleanup & alerts
            </p>
            {lastHousekeep.map((entry, i) => (
              <TooltipProvider key={i}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="text-xs text-muted-foreground truncate cursor-help">
                      {formatAge(entry.created_at)} — {(entry.metadata as any)?.jobType ?? "housekeep"}
                      {(entry.metadata as any)?.attempts ? ` (${(entry.metadata as any).attempts} pogingen)` : ""}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-xs text-xs">
                    {(entry.metadata as any)?.error ?? "Geen details beschikbaar"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

function StatCell({
  icon: Icon,
  label,
  value,
  color,
  spinning,
}: {
  icon: typeof Clock;
  label: string;
  value: number;
  color: string;
  spinning?: boolean;
}) {
  return (
    <div className="text-center rounded-lg bg-muted/50 p-2">
      <Icon className={`h-4 w-4 mx-auto mb-1 ${color} ${spinning ? "animate-spin" : ""}`} />
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
