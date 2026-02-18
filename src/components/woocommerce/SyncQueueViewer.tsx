import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RefreshCw, Trash2, RotateCw, Clock, Loader2, CheckCircle2, XCircle, Package } from "lucide-react";
import { toast } from "sonner";

interface SyncQueueViewerProps {
  tenantId?: string;
  maxItems?: number;
}

export const SyncQueueViewer = ({ tenantId, maxItems = 25 }: SyncQueueViewerProps) => {
  const queryClient = useQueryClient();

  const { data: queueJobs, isLoading } = useQuery({
    queryKey: ["sync-queue", tenantId],
    queryFn: async () => {
      let query = supabase
        .from("jobs")
        .select("id, type, state, attempts, error, created_at, updated_at, payload, tenant_id")
        .eq("type", "SYNC_TO_WOO")
        .order("created_at", { ascending: false })
        .limit(maxItems);

      if (tenantId && tenantId !== "all") {
        query = query.eq("tenant_id", tenantId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 5000,
  });

  const retryMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const { error } = await supabase
        .from("jobs")
        .update({ state: "ready", attempts: 0, error: null, updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Job opnieuw ingepland");
      queryClient.invalidateQueries({ queryKey: ["sync-queue"] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const cancelMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const { error } = await supabase
        .from("jobs")
        .delete()
        .eq("id", jobId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Job verwijderd");
      queryClient.invalidateQueries({ queryKey: ["sync-queue"] });
      queryClient.invalidateQueries({ queryKey: ["pending-sync-job"] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const clearDoneMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("jobs")
        .delete()
        .eq("type", "SYNC_TO_WOO")
        .eq("state", "done");
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Voltooide jobs opgeruimd");
      queryClient.invalidateQueries({ queryKey: ["sync-queue"] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const stateConfig: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    ready: {
      icon: <Clock className="h-3.5 w-3.5" />,
      label: "Wachtrij",
      className: "bg-muted text-muted-foreground",
    },
    processing: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      label: "Verwerken",
      className: "bg-primary/10 text-primary border-primary/20",
    },
    done: {
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      label: "Voltooid",
      className: "bg-success/10 text-success border-success/20",
    },
    error: {
      icon: <XCircle className="h-3.5 w-3.5" />,
      label: "Fout",
      className: "bg-destructive/10 text-destructive border-destructive/20",
    },
  };

  const counts = {
    ready: queueJobs?.filter((j) => j.state === "ready").length || 0,
    processing: queueJobs?.filter((j) => j.state === "processing").length || 0,
    done: queueJobs?.filter((j) => j.state === "done").length || 0,
    error: queueJobs?.filter((j) => j.state === "error").length || 0,
  };

  const getProductCount = (job: any) => {
    const ids = (job.payload as any)?.productIds;
    return Array.isArray(ids) ? ids.length : 0;
  };

  const getDuration = (job: any) => {
    const seconds = Math.round(
      (new Date(job.updated_at).getTime() - new Date(job.created_at).getTime()) / 1000
    );
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Sync Wachtrij
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5">
              {counts.ready > 0 && (
                <Badge variant="outline" className="text-xs bg-muted">{counts.ready} wachtend</Badge>
              )}
              {counts.processing > 0 && (
                <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/20">
                  {counts.processing} actief
                </Badge>
              )}
              {counts.error > 0 && (
                <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/20">
                  {counts.error} fouten
                </Badge>
              )}
            </div>
            {counts.done > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clearDoneMutation.mutate()}
                disabled={clearDoneMutation.isPending}
                className="h-7 text-xs"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Opruimen ({counts.done})
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Laden…
          </div>
        ) : !queueJobs?.length ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            Geen sync-jobs gevonden
          </div>
        ) : (
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-2">
              {queueJobs.map((job) => {
                const config = stateConfig[job.state] || stateConfig.ready;
                const productCount = getProductCount(job);

                return (
                  <div
                    key={job.id}
                    className="flex items-center gap-3 rounded-lg border p-3 text-sm"
                  >
                    {/* State badge */}
                    <Badge variant="outline" className={`${config.className} gap-1 text-xs flex-shrink-0`}>
                      {config.icon}
                      {config.label}
                    </Badge>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">
                          {productCount} product{productCount !== 1 ? "en" : ""}
                        </span>
                        {job.attempts > 0 && (
                          <span className="text-xs text-muted-foreground">
                            poging {job.attempts}
                          </span>
                        )}
                      </div>
                      {job.error && (
                        <p className="text-xs text-destructive truncate mt-0.5">
                          {job.error.slice(0, 100)}
                        </p>
                      )}
                    </div>

                    {/* Timing */}
                    <div className="text-xs text-muted-foreground flex-shrink-0 text-right">
                      <div>{new Date(job.created_at).toLocaleString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
                      {job.state === "done" && (
                        <div className="text-success">{getDuration(job)}</div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {job.state === "error" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => retryMutation.mutate(job.id)}
                          disabled={retryMutation.isPending}
                          title="Opnieuw proberen"
                        >
                          <RotateCw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {(job.state === "ready" || job.state === "error" || job.state === "done") && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => cancelMutation.mutate(job.id)}
                          disabled={cancelMutation.isPending}
                          title="Verwijderen"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
};
