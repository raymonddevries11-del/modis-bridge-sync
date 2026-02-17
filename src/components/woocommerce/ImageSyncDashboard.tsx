import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Image, CheckCircle2, XCircle, Clock, Loader2, ImageOff, TrendingUp,
} from "lucide-react";

interface ImageSyncDashboardProps {
  tenantId: string;
}

export const ImageSyncDashboard = ({ tenantId }: ImageSyncDashboardProps) => {
  const { data: stats } = useQuery({
    queryKey: ["image-sync-stats", tenantId],
    queryFn: async () => {
      // Get pending image syncs
      const { count: pendingImages } = await supabase
        .from("pending_product_syncs")
        .select("product_id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("reason", "images");

      // Get all pending syncs by reason
      const { data: pendingByReason } = await supabase
        .from("pending_product_syncs")
        .select("reason")
        .eq("tenant_id", tenantId);

      const reasonCounts: Record<string, number> = {};
      for (const row of pendingByReason || []) {
        reasonCounts[row.reason] = (reasonCounts[row.reason] || 0) + 1;
      }

      // Get total products with images
      const { count: productsWithImages } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .not("images", "is", null)
        .neq("images", "[]");

      // Get active SYNC_TO_WOO jobs
      const { count: activeJobs } = await supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("type", "SYNC_TO_WOO")
        .in("state", ["ready", "processing"]);

      // Get recent image-related changelog entries
      const since6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const { data: recentLogs } = await supabase
        .from("changelog")
        .select("event_type, description, metadata, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", since6h)
        .or("event_type.eq.WOO_PRODUCT_PUSH,event_type.eq.WOO_IMAGE_UPLOAD_FAILED")
        .order("created_at", { ascending: false })
        .limit(20);

      // Count image upload failures vs successes
      let imageFailures = 0;
      let imagePushes = 0;
      for (const log of recentLogs || []) {
        if (log.event_type === "WOO_IMAGE_UPLOAD_FAILED") imageFailures++;
        if (log.event_type === "WOO_PRODUCT_PUSH") imagePushes++;
      }

      // Products with images linked to WooCommerce
      const { count: linkedWithImages } = await supabase
        .from("products")
        .select("id, woo_products!inner(id)", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .not("images", "is", null)
        .neq("images", "[]");

      return {
        pendingImages: pendingImages ?? 0,
        pendingByReason: reasonCounts,
        productsWithImages: productsWithImages ?? 0,
        linkedWithImages: linkedWithImages ?? 0,
        activeJobs: activeJobs ?? 0,
        imageFailures,
        imagePushes,
        recentLogs: recentLogs || [],
      };
    },
    enabled: !!tenantId,
    refetchInterval: 10000,
  });

  if (!stats) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalPending = Object.values(stats.pendingByReason).reduce((a, b) => a + b, 0);
  const completedImages = stats.linkedWithImages - stats.pendingImages;
  const progressPct = stats.linkedWithImages > 0
    ? Math.round(((stats.linkedWithImages - stats.pendingImages) / stats.linkedWithImages) * 100)
    : 100;

  return (
    <div className="space-y-4">
      {/* Progress overview */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          icon={Image}
          iconClass="text-primary"
          label="Afbeeldingen in PIM"
          value={stats.productsWithImages}
          sub={`${stats.linkedWithImages} gekoppeld aan WooCommerce`}
        />
        <StatCard
          icon={Clock}
          iconClass="text-warning"
          label="Pending Image Syncs"
          value={stats.pendingImages}
          sub={stats.pendingImages > 0 ? "In wachtrij voor push" : "Alles up-to-date"}
          highlight={stats.pendingImages > 0}
        />
        <StatCard
          icon={stats.activeJobs > 0 ? Loader2 : CheckCircle2}
          iconClass={stats.activeJobs > 0 ? "text-primary animate-spin" : "text-success"}
          label="Actieve Sync Jobs"
          value={stats.activeJobs}
          sub="SYNC_TO_WOO jobs"
        />
        <StatCard
          icon={stats.imageFailures > 0 ? ImageOff : TrendingUp}
          iconClass={stats.imageFailures > 0 ? "text-destructive" : "text-success"}
          label="Upload Status (6u)"
          value={`${stats.imagePushes} OK`}
          sub={stats.imageFailures > 0 ? `${stats.imageFailures} mislukt` : "Geen fouten"}
          highlight={stats.imageFailures > 0}
        />
      </div>

      {/* Progress bar */}
      {stats.pendingImages > 0 && (
        <Card className="card-elevated">
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium flex items-center gap-2">
                <Image className="h-4 w-4 text-primary" />
                Afbeelding sync voortgang
              </span>
              <span className="text-muted-foreground">
                {completedImages} / {stats.linkedWithImages} producten
              </span>
            </div>
            <Progress value={Math.max(progressPct, 2)} className="h-2" />
            <p className="text-xs text-muted-foreground">
              Nog {stats.pendingImages} producten wachten op afbeelding push naar WooCommerce.
              {stats.activeJobs > 0
                ? ` ${stats.activeJobs} jobs actief — wordt automatisch verwerkt.`
                : " Geen actieve jobs — de batch processor pikt nieuwe items elke minuut op."
              }
            </p>
          </CardContent>
        </Card>
      )}

      {/* Pending by reason breakdown */}
      {totalPending > 0 && (
        <Card className="card-elevated">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Pending Syncs per Type</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(stats.pendingByReason)
                .sort(([, a], [, b]) => b - a)
                .map(([reason, count]) => {
                  const pct = Math.round((count / totalPending) * 100);
                  const isImage = reason === "images";
                  return (
                    <div key={reason} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          {isImage ? <Image className="h-3 w-3 text-primary" /> : <Clock className="h-3 w-3" />}
                          {reason}
                          {isImage && <Badge variant="secondary" className="text-[9px] px-1 py-0">actief</Badge>}
                        </span>
                        <span className="font-medium">{count} <span className="text-muted-foreground font-normal">({pct}%)</span></span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${isImage ? "bg-primary" : "bg-muted-foreground/50"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent activity */}
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            Recente Activiteit
            <Badge variant="outline" className="text-[10px]">6u</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats.recentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Geen recente image sync activiteit.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {stats.recentLogs.map((log, i) => {
                const isError = log.event_type === "WOO_IMAGE_UPLOAD_FAILED";
                const meta = log.metadata as any;
                return (
                  <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isError ? (
                        <XCircle className="h-3 w-3 text-destructive flex-shrink-0" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 text-success flex-shrink-0" />
                      )}
                      <span className="truncate text-muted-foreground">
                        {log.description?.substring(0, 80) || log.event_type}
                        {meta?.sku && <span className="ml-1 font-mono text-foreground/70">[{meta.sku}]</span>}
                      </span>
                    </div>
                    <span className="text-muted-foreground flex-shrink-0 ml-2">
                      {new Date(log.created_at).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

function StatCard({ icon: Icon, iconClass, label, value, sub, highlight }: {
  icon: typeof Image; iconClass: string; label: string; value: number | string; sub: string; highlight?: boolean;
}) {
  return (
    <Card className={`card-elevated ${highlight ? "border-warning/30" : ""}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Icon className={`h-5 w-5 ${iconClass}`} />
          <span className="text-2xl font-semibold">{value}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}
