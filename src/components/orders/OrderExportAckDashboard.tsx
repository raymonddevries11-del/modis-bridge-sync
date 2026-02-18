import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Clock, AlertTriangle, Upload, Package, ShieldAlert, RotateCw, Archive, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";

interface ExportFile {
  id: string;
  filename: string;
  order_number: string;
  storage_path: string;
  synced_to_sftp: boolean;
  ack_status: string;
  created_at: string;
  synced_at: string | null;
  uploaded_to_sftp_at: string | null;
  retry_count: number;
  max_retries: number;
  last_retry_at: string | null;
  reconciled_at: string | null;
  archived_at: string | null;
}

const statusConfig: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  pending: { label: "Wacht op upload", icon: Clock, color: "bg-muted text-muted-foreground" },
  uploaded: { label: "Op SFTP, wacht op ACK", icon: Upload, color: "bg-warning/10 text-warning border-warning/20" },
  acked: { label: "Opgepikt, wacht op validatie", icon: CheckCircle2, color: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  reconciled: { label: "Gevalideerd & gearchiveerd", icon: Archive, color: "bg-success/10 text-success border-success/20" },
  timeout: { label: "Timeout – wordt herstart", icon: RotateCw, color: "bg-orange-500/10 text-orange-600 border-orange-500/20" },
  quarantined: { label: "Quarantaine", icon: ShieldAlert, color: "bg-destructive/10 text-destructive border-destructive/20" },
};

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m geleden`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}u geleden`;
  return `${Math.floor(hrs / 24)}d geleden`;
}

export function OrderExportAckDashboard({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();

  const { data: exports, isLoading } = useQuery({
    queryKey: ["export-files-ack", tenantId],
    queryFn: async () => {
      if (!tenantId) return [];
      const { data } = await supabase
        .from("export_files")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(100);
      return (data || []) as ExportFile[];
    },
    refetchInterval: 30000,
  });

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('reconcile-orders');
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: `Reconciliatie voltooid`,
        description: `${data.reconciled} gevalideerd, ${data.failed} mislukt, ${data.skipped} overgeslagen`,
      });
      queryClient.invalidateQueries({ queryKey: ["export-files-ack"] });
    },
    onError: (e: any) => {
      toast({ title: "Reconciliatie mislukt", description: e.message, variant: "destructive" });
    },
  });

  const stats = {
    pending: exports?.filter(e => e.ack_status === "pending").length || 0,
    uploaded: exports?.filter(e => e.ack_status === "uploaded").length || 0,
    acked: exports?.filter(e => e.ack_status === "acked").length || 0,
    reconciled: exports?.filter(e => e.ack_status === "reconciled").length || 0,
    timeout: exports?.filter(e => e.ack_status === "timeout").length || 0,
    quarantined: exports?.filter(e => e.ack_status === "quarantined").length || 0,
  };

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Laden...</div>;
  }

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {Object.entries(statusConfig).map(([key, cfg]) => {
          const Icon = cfg.icon;
          const count = stats[key as keyof typeof stats] || 0;
          return (
            <Card key={key}>
              <CardContent className="pt-4 pb-3 flex items-center gap-3">
                <div className={`h-9 w-9 rounded-lg flex items-center justify-center ${cfg.color}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{count}</p>
                  <p className="text-xs text-muted-foreground">{cfg.label}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Reconcile action */}
      {stats.acked > 0 && (
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardContent className="py-4 flex items-center justify-between">
            <div>
              <p className="font-medium">{stats.acked} order(s) wachten op validatie</p>
              <p className="text-sm text-muted-foreground">
                Valideer XML-inhoud en archiveer afgehandelde exports
              </p>
            </div>
            <Button onClick={() => reconcileMutation.mutate()} disabled={reconcileMutation.isPending}>
              {reconcileMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Archive className="mr-2 h-4 w-4" />
              )}
              Valideer & Archiveer
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Export list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Recente exports
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!exports || exports.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">Geen exports gevonden</p>
          ) : (
            <div className="divide-y">
              {exports.map((exp) => {
                const cfg = statusConfig[exp.ack_status] || statusConfig.pending;
                const Icon = cfg.icon;
                const showRetry = exp.retry_count > 0;
                return (
                  <div key={exp.id} className="flex items-center justify-between py-3 gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{exp.order_number}</p>
                        <p className="text-xs text-muted-foreground truncate">{exp.filename}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {showRetry && (
                        <span className="text-xs text-muted-foreground">
                          poging {exp.retry_count}/{exp.max_retries}
                        </span>
                      )}
                      {exp.reconciled_at && (
                        <span className="text-xs text-muted-foreground">
                          ✓ {timeAgo(exp.reconciled_at)}
                        </span>
                      )}
                      <Badge variant="outline" className={cfg.color}>
                        {cfg.label}
                      </Badge>
                      <span className="text-xs text-muted-foreground w-20 text-right">
                        {timeAgo(exp.created_at)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
