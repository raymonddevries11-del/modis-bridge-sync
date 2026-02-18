import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-function-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, Activity, RefreshCw, Loader2, CheckCircle2, AlertTriangle, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const SyncWatchdogWidget = () => {
  const queryClient = useQueryClient();

  const { data: state, isLoading } = useQuery({
    queryKey: ["sync-watchdog-state"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("config")
        .select("value")
        .eq("key", "sync_watchdog_state")
        .maybeSingle();
      if (error) throw error;
      return data?.value as {
        last_run: string;
        metrics: { jobs_last_hour: number; active_jobs: number; pending_products: number; error_jobs_last_hour: number };
        alerts: string[];
        adjustments: Array<{ field: string; from: number; to: number; reason: string }>;
        config_changed: boolean;
      } | null;
    },
    refetchInterval: 30000,
  });

  const runMutation = useMutation({
    mutationFn: async () => {
      return await invokeEdgeFunction<{ alerts: any[] }>("sync-watchdog", { maxRetries: 2 });
    },
    onSuccess: (data) => {
      if (data.alerts?.length > 0) {
        toast.warning(`Watchdog: ${data.alerts.length} waarschuwing(en)`);
      } else {
        toast.success("Watchdog: alles stabiel");
      }
      queryClient.invalidateQueries({ queryKey: ["sync-watchdog-state"] });
    },
    onError: (e: any) => toast.error(`Watchdog fout: ${e.message}`),
  });

  const hasAlerts = (state?.alerts?.length || 0) > 0;
  const hasAdjustments = (state?.adjustments?.length || 0) > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            Sync Watchdog
          </CardTitle>
          <div className="flex items-center gap-2">
            {state && !hasAlerts && (
              <Badge variant="outline" className="text-xs bg-success/10 text-success border-success/20">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Stabiel
              </Badge>
            )}
            {hasAlerts && (
              <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/20">
                <AlertTriangle className="h-3 w-3 mr-1" /> {state!.alerts.length} waarschuwing{state!.alerts.length > 1 ? "en" : ""}
              </Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Laden…
          </div>
        ) : !state ? (
          <div className="text-center py-4 text-muted-foreground text-sm">
            Watchdog nog niet uitgevoerd.
            <Button size="sm" variant="link" onClick={() => runMutation.mutate()} className="ml-1">
              Nu uitvoeren
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Metrics */}
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-md border p-2 text-center">
                <div className="text-lg font-semibold">{state.metrics.jobs_last_hour}</div>
                <div className="text-xs text-muted-foreground">Jobs/uur</div>
              </div>
              <div className="rounded-md border p-2 text-center">
                <div className="text-lg font-semibold">{state.metrics.active_jobs}</div>
                <div className="text-xs text-muted-foreground">Actief</div>
              </div>
              <div className="rounded-md border p-2 text-center">
                <div className="text-lg font-semibold">{state.metrics.pending_products}</div>
                <div className="text-xs text-muted-foreground">Pending</div>
              </div>
              <div className="rounded-md border p-2 text-center">
                <div className="text-lg font-semibold">{state.metrics.error_jobs_last_hour}</div>
                <div className="text-xs text-muted-foreground">Fouten/uur</div>
              </div>
            </div>

            {/* Alerts */}
            {hasAlerts && (
              <div className="space-y-1">
                {state.alerts.map((alert, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md bg-warning/5 border border-warning/20 p-2 text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 text-warning flex-shrink-0 mt-0.5" />
                    <span>{alert}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Auto-adjustments */}
            {hasAdjustments && (
              <div className="space-y-1">
                {state.adjustments.map((adj, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-md bg-primary/5 border border-primary/20 p-2 text-xs">
                    <ArrowUpDown className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                    <span>
                      <span className="font-medium">{adj.field}</span>: {adj.from} → {adj.to}
                      <span className="text-muted-foreground ml-1">({adj.reason})</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Last run */}
            <div className="text-xs text-muted-foreground text-right">
              Laatste run: {new Date(state.last_run).toLocaleString("nl-NL", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
