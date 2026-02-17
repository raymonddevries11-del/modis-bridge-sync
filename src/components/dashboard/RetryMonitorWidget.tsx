import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  Eye, RefreshCw, AlertTriangle, CheckCircle2, Clock,
  ShieldAlert, Loader2, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

interface MonitorAction {
  jobId: string;
  type: string;
  action: "retried" | "retried_from_error" | "escalated";
  reason: string;
}

interface MonitorState {
  last_run: string | null;
  retried: number;
  escalated: number;
  stuck_found: number;
  error_retryable: number;
  actions: MonitorAction[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "zojuist";
  if (mins < 60) return `${mins}m geleden`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}u geleden`;
  return `${Math.floor(hours / 24)}d geleden`;
}

export const RetryMonitorWidget = () => {
  const queryClient = useQueryClient();

  // Monitor state
  const { data: monitorState } = useQuery({
    queryKey: ["retry-monitor-state"],
    queryFn: async (): Promise<MonitorState | null> => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", "retry_monitor_state")
        .maybeSingle();
      return (data?.value as unknown as MonitorState) ?? null;
    },
    refetchInterval: 15000,
  });

  // Live stuck count
  const { data: liveStuck } = useQuery({
    queryKey: ["retry-monitor-live-stuck"],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
      const { count } = await supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("state", "processing")
        .lt("updated_at", cutoff);
      return count ?? 0;
    },
    refetchInterval: 10000,
  });

  // Escalated jobs (recent)
  const { data: escalatedJobs } = useQuery({
    queryKey: ["retry-monitor-escalated"],
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const { data } = await supabase
        .from("changelog")
        .select("id, description, metadata, created_at")
        .eq("event_type", "JOB_ESCALATED")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5);
      return data ?? [];
    },
    refetchInterval: 15000,
  });

  // Manual trigger
  const runMonitor = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("retry-monitor");
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      toast.success(
        `Monitor: ${data.retried} herstart, ${data.escalated} geëscaleerd`,
      );
      queryClient.invalidateQueries({ queryKey: ["retry-monitor-state"] });
      queryClient.invalidateQueries({ queryKey: ["retry-monitor-live-stuck"] });
      queryClient.invalidateQueries({ queryKey: ["retry-monitor-escalated"] });
    },
    onError: (e: any) => toast.error(`Monitor fout: ${e.message}`),
  });

  const hasIssues = (liveStuck ?? 0) > 0 || (escalatedJobs?.length ?? 0) > 0;
  const actionIcon = (action: string) => {
    if (action === "escalated") return <ShieldAlert className="h-3 w-3 text-destructive" />;
    return <RefreshCw className="h-3 w-3 text-primary" />;
  };

  return (
    <Card className={`card-elevated ${hasIssues ? "border-warning/30" : ""}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />
          Retry Monitor
          <div className="ml-auto flex items-center gap-2">
            {(liveStuck ?? 0) > 0 && (
              <Badge variant="outline" className="text-[10px] border-destructive/50 text-destructive">
                {liveStuck} stuck
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => runMonitor.mutate()}
              disabled={runMonitor.isPending}
            >
              {runMonitor.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Scan nu
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-muted/50 p-2">
            <Clock className="h-4 w-4 mx-auto mb-1 text-warning" />
            <p className="text-lg font-bold">{liveStuck ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">Stuck nu</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <RefreshCw className="h-4 w-4 mx-auto mb-1 text-primary" />
            <p className="text-lg font-bold">{monitorState?.retried ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">Herstart</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <ShieldAlert className="h-4 w-4 mx-auto mb-1 text-destructive" />
            <p className="text-lg font-bold">{monitorState?.escalated ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">Geëscaleerd</p>
          </div>
        </div>

        {/* Last run info */}
        {monitorState?.last_run && (
          <p className="text-xs text-muted-foreground text-center">
            Laatste scan: {timeAgo(monitorState.last_run)}
          </p>
        )}

        {/* Recent actions */}
        {monitorState?.actions && monitorState.actions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Recente acties</p>
            {monitorState.actions.slice(0, 5).map((action, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-xs rounded-md bg-muted/30 px-2.5 py-1.5"
              >
                {actionIcon(action.action)}
                <span className="font-medium truncate flex-1">
                  {action.type.replace(/_/g, " ")}
                </span>
                <span className="text-muted-foreground truncate max-w-[140px]">
                  {action.reason}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Escalated jobs */}
        {escalatedJobs && escalatedJobs.length > 0 && (
          <div className="border-t pt-3 space-y-1.5">
            <p className="text-xs font-medium text-destructive flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Geëscaleerde jobs (24u)
            </p>
            {escalatedJobs.map((entry) => (
              <TooltipProvider key={entry.id}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2 text-xs cursor-help">
                      <ShieldAlert className="h-3 w-3 text-destructive flex-shrink-0" />
                      <span className="truncate flex-1">{entry.description}</span>
                      <span className="text-muted-foreground flex-shrink-0">
                        {timeAgo(entry.created_at)}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-xs text-xs">
                    <p><strong>Job ID:</strong> {(entry.metadata as any)?.jobId}</p>
                    <p><strong>Pogingen:</strong> {(entry.metadata as any)?.attempts}</p>
                    <p><strong>Fout:</strong> {(entry.metadata as any)?.lastError ?? "Onbekend"}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>
        )}

        {/* All clear */}
        {!hasIssues && !monitorState?.actions?.length && (
          <div className="flex items-center justify-center gap-2 text-sm text-success py-2">
            <CheckCircle2 className="h-4 w-4" />
            Alle jobs draaien normaal
          </div>
        )}
      </CardContent>
    </Card>
  );
};
