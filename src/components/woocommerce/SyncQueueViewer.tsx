import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, Trash2, RotateCw, Clock, Loader2, CheckCircle2, XCircle, Package, ChevronDown, ChevronRight, Layers } from "lucide-react";
import { toast } from "sonner";

interface SyncQueueViewerProps {
  tenantId?: string;
  maxItems?: number;
}

interface JobRow {
  id: string;
  type: string;
  state: string;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  payload: any;
  tenant_id: string | null;
}

interface JobGroup {
  id: string; // first job's id or synthetic
  jobs: JobRow[];
  totalProducts: number;
  state: string; // aggregated: processing > ready > error > done
  firstCreated: string;
  lastUpdated: string;
  hasErrors: boolean;
}

/** Group jobs created within a 60s window into visual batches */
function groupJobs(jobs: JobRow[]): JobGroup[] {
  if (!jobs.length) return [];

  const sorted = [...jobs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const groups: JobGroup[] = [];
  let current: JobRow[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].created_at).getTime();
    const curr = new Date(sorted[i].created_at).getTime();
    // Group if created within 60s of each other and same tenant
    if (curr - prev < 60_000 && sorted[i].tenant_id === sorted[i - 1].tenant_id) {
      current.push(sorted[i]);
    } else {
      groups.push(buildGroup(current));
      current = [sorted[i]];
    }
  }
  groups.push(buildGroup(current));

  // Sort groups newest first
  return groups.sort((a, b) => new Date(b.firstCreated).getTime() - new Date(a.firstCreated).getTime());
}

function buildGroup(jobs: JobRow[]): JobGroup {
  const totalProducts = jobs.reduce((sum, j) => {
    const ids = (j.payload as any)?.productIds;
    return sum + (Array.isArray(ids) ? ids.length : 0);
  }, 0);

  // Aggregate state: if any processing → processing, any ready → ready, any error → error, else done
  let state = "done";
  if (jobs.some(j => j.state === "processing")) state = "processing";
  else if (jobs.some(j => j.state === "ready")) state = "ready";
  else if (jobs.some(j => j.state === "error")) state = "error";

  return {
    id: jobs[0].id,
    jobs,
    totalProducts,
    state,
    firstCreated: jobs[0].created_at,
    lastUpdated: jobs[jobs.length - 1].updated_at,
    hasErrors: jobs.some(j => !!j.error),
  };
}

export const SyncQueueViewer = ({ tenantId, maxItems = 50 }: SyncQueueViewerProps) => {
  const queryClient = useQueryClient();
  const [cancelTarget, setCancelTarget] = useState<{ id: string; productCount: number } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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
      return (data || []) as JobRow[];
    },
    refetchInterval: 5000,
  });

  const groups = useMemo(() => groupJobs(queueJobs || []), [queueJobs]);

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
      const { error } = await supabase.from("jobs").delete().eq("id", jobId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Job verwijderd");
      queryClient.invalidateQueries({ queryKey: ["sync-queue"] });
      queryClient.invalidateQueries({ queryKey: ["pending-sync-job"] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const cancelGroupMutation = useMutation({
    mutationFn: async (jobIds: string[]) => {
      for (const id of jobIds) {
        const { error } = await supabase.from("jobs").delete().eq("id", id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Groep verwijderd");
      queryClient.invalidateQueries({ queryKey: ["sync-queue"] });
      queryClient.invalidateQueries({ queryKey: ["pending-sync-job"] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const clearDoneMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("jobs").delete().eq("type", "SYNC_TO_WOO").eq("state", "done");
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Voltooide jobs opgeruimd");
      queryClient.invalidateQueries({ queryKey: ["sync-queue"] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const stateConfig: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
    ready: { icon: <Clock className="h-3.5 w-3.5" />, label: "Wachtrij", className: "bg-muted text-muted-foreground" },
    processing: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, label: "Verwerken", className: "bg-primary/10 text-primary border-primary/20" },
    done: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, label: "Voltooid", className: "bg-success/10 text-success border-success/20" },
    error: { icon: <XCircle className="h-3.5 w-3.5" />, label: "Fout", className: "bg-destructive/10 text-destructive border-destructive/20" },
  };

  const flatCounts = {
    ready: queueJobs?.filter((j) => j.state === "ready").length || 0,
    processing: queueJobs?.filter((j) => j.state === "processing").length || 0,
    done: queueJobs?.filter((j) => j.state === "done").length || 0,
    error: queueJobs?.filter((j) => j.state === "error").length || 0,
  };

  const getProductCount = (job: JobRow) => {
    const ids = (job.payload as any)?.productIds;
    return Array.isArray(ids) ? ids.length : 0;
  };

  const getDuration = (job: JobRow) => {
    const seconds = Math.round((new Date(job.updated_at).getTime() - new Date(job.created_at).getTime()) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const getProgress = (job: JobRow) => {
    const progress = (job.payload as any)?.progress;
    if (!progress || !progress.total) return null;
    return progress as { processed: number; total: number; synced: number; failed: number };
  };

  const renderSingleJob = (job: JobRow, compact = false) => {
    const config = stateConfig[job.state] || stateConfig.ready;
    const productCount = getProductCount(job);
    const progress = getProgress(job);
    const progressPct = progress ? Math.round((progress.processed / progress.total) * 100) : 0;

    return (
      <div key={job.id} className={`rounded-lg border p-3 text-sm ${compact ? "ml-4 border-dashed" : ""}`}>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className={`${config.className} gap-1 text-xs flex-shrink-0`}>
            {config.icon}
            {config.label}
          </Badge>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">
                {productCount} product{productCount !== 1 ? "en" : ""}
              </span>
              {job.attempts > 0 && <span className="text-xs text-muted-foreground">poging {job.attempts}</span>}
            </div>
            {job.error && <p className="text-xs text-destructive truncate mt-0.5">{job.error.slice(0, 100)}</p>}
          </div>
          <div className="text-xs text-muted-foreground flex-shrink-0 text-right">
            <div>{new Date(job.created_at).toLocaleString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
            {job.state === "done" && <div className="text-success">{getDuration(job)}</div>}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {job.state === "error" && (
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => retryMutation.mutate(job.id)} disabled={retryMutation.isPending} title="Opnieuw proberen">
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
            )}
            {(job.state === "ready" || job.state === "error" || job.state === "done") && (
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => setCancelTarget({ id: job.id, productCount })} disabled={cancelMutation.isPending} title="Annuleren">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        {/* Live progress bar for processing jobs */}
        {job.state === "processing" && progress && (
          <div className="mt-2 space-y-1">
            <Progress value={progressPct} className="h-1.5" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{progress.processed}/{progress.total} verwerkt</span>
              <div className="flex gap-2">
                {progress.synced > 0 && <span className="text-success">{progress.synced} ✓</span>}
                {progress.failed > 0 && <span className="text-destructive">{progress.failed} ✗</span>}
                <span>{progressPct}%</span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
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
              {flatCounts.ready > 0 && <Badge variant="outline" className="text-xs bg-muted">{flatCounts.ready} wachtend</Badge>}
              {flatCounts.processing > 0 && (
                <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/20">{flatCounts.processing} actief</Badge>
              )}
              {flatCounts.error > 0 && (
                <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/20">{flatCounts.error} fouten</Badge>
              )}
            </div>
            {flatCounts.done > 0 && (
              <Button size="sm" variant="ghost" onClick={() => clearDoneMutation.mutate()} disabled={clearDoneMutation.isPending} className="h-7 text-xs">
                <Trash2 className="h-3 w-3 mr-1" />
                Opruimen ({flatCounts.done})
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
        ) : !groups.length ? (
          <div className="text-center py-6 text-muted-foreground text-sm">Geen sync-jobs gevonden</div>
        ) : (
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-2">
              {groups.map((group) => {
                const config = stateConfig[group.state] || stateConfig.ready;
                const isExpanded = expandedGroups.has(group.id);
                const isSingle = group.jobs.length === 1;

                if (isSingle) {
                  return renderSingleJob(group.jobs[0]);
                }

                // Grouped view
                const doneCount = group.jobs.filter(j => j.state === "done").length;
                const canCancelAll = group.jobs.some(j => j.state === "ready" || j.state === "error");

                // Aggregate progress across all jobs in the group
                const groupProgress = group.jobs.reduce((acc, j) => {
                  const p = getProgress(j);
                  if (p) {
                    acc.processed += p.processed;
                    acc.total += p.total;
                    acc.synced += p.synced;
                    acc.failed += p.failed;
                    acc.hasProgress = true;
                  } else {
                    const count = getProductCount(j);
                    acc.total += count;
                    if (j.state === "done") { acc.processed += count; acc.synced += count; acc.hasProgress = true; }
                  }
                  return acc;
                }, { processed: 0, total: 0, synced: 0, failed: 0, hasProgress: false });
                const groupPct = groupProgress.total > 0 ? Math.round((groupProgress.processed / groupProgress.total) * 100) : 0;

                return (
                  <Collapsible key={group.id} open={isExpanded} onOpenChange={() => toggleGroup(group.id)}>
                    <div className="rounded-lg border p-3 text-sm">
                      <CollapsibleTrigger asChild>
                        <div className="flex items-center gap-3 cursor-pointer hover:bg-muted/50 -m-1 p-1 rounded">
                          <div className="flex-shrink-0 text-muted-foreground">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </div>
                          <Badge variant="outline" className={`${config.className} gap-1 text-xs flex-shrink-0`}>
                            {config.icon}
                            {config.label}
                          </Badge>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="font-medium">
                                {group.totalProducts} product{group.totalProducts !== 1 ? "en" : ""}
                              </span>
                              <Badge variant="secondary" className="text-xs">
                                {group.jobs.length} jobs
                              </Badge>
                              {doneCount > 0 && doneCount < group.jobs.length && (
                                <span className="text-xs text-muted-foreground">
                                  {doneCount}/{group.jobs.length} voltooid
                                </span>
                              )}
                            </div>
                            {group.hasErrors && (
                              <p className="text-xs text-destructive mt-0.5">Bevat fouten — klik om details te zien</p>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground flex-shrink-0 text-right">
                            {new Date(group.firstCreated).toLocaleString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                          </div>
                          {canCancelAll && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive flex-shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                const deletableIds = group.jobs
                                  .filter(j => j.state === "ready" || j.state === "error" || j.state === "done")
                                  .map(j => j.id);
                                const totalProds = group.totalProducts;
                                setCancelTarget({ id: deletableIds.join(","), productCount: totalProds });
                              }}
                              disabled={cancelGroupMutation.isPending}
                              title="Hele groep annuleren"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </CollapsibleTrigger>
                      {/* Group-level progress bar */}
                      {(group.state === "processing" || group.state === "ready") && groupProgress.hasProgress && (
                        <div className="mt-2 space-y-1 px-1">
                          <Progress value={groupPct} className="h-1.5" />
                          <div className="flex justify-between text-[10px] text-muted-foreground">
                            <span>{groupProgress.processed}/{groupProgress.total} verwerkt</span>
                            <div className="flex gap-2">
                              {groupProgress.synced > 0 && <span className="text-success">{groupProgress.synced} ✓</span>}
                              {groupProgress.failed > 0 && <span className="text-destructive">{groupProgress.failed} ✗</span>}
                              <span>{groupPct}%</span>
                            </div>
                          </div>
                        </div>
                      )}
                      <CollapsibleContent>
                        <div className="mt-2 space-y-1.5">
                          {group.jobs.map((job) => renderSingleJob(job, true))}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          </ScrollArea>
        )}

        {/* Cancel confirmation dialog */}
        <AlertDialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Sync-job annuleren?</AlertDialogTitle>
              <AlertDialogDescription>
                Weet je zeker dat je deze sync-job wilt annuleren?
                {cancelTarget && cancelTarget.productCount > 0 && (
                  <span className="block mt-1 font-medium">
                    {cancelTarget.productCount} product{cancelTarget.productCount !== 1 ? "en" : ""} zal niet naar WooCommerce worden gesynchroniseerd.
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Behouden</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  if (cancelTarget) {
                    const ids = cancelTarget.id.split(",");
                    if (ids.length > 1) {
                      cancelGroupMutation.mutate(ids);
                    } else {
                      cancelMutation.mutate(ids[0]);
                    }
                    setCancelTarget(null);
                  }
                }}
              >
                Annuleren
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
};
