import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Image, CheckCircle2, XCircle, Clock, Loader2, ImageOff, TrendingUp, Webhook, ShieldCheck, RotateCcw, AlertTriangle, Play, Square, Trash2, Search, Send,
} from "lucide-react";
import { toast } from "sonner";

interface ImageSyncDashboardProps {
  tenantId: string;
}

export const ImageSyncDashboard = ({ tenantId }: ImageSyncDashboardProps) => {
  const [retrying, setRetrying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const [manualSyncing, setManualSyncing] = useState(false);
  const queryClient = useQueryClient();

  const { data: stats, refetch } = useQuery({
    queryKey: ["image-sync-stats", tenantId],
    queryFn: async () => {
      const [
        pendingRes,
        pendingByReasonRes,
        productsWithImagesRes,
        activeJobsRes,
        recentLogsRes,
        linkedWithImagesRes,
        statusUploadedRes,
        statusConfirmedRes,
        statusFailedRes,
        statusPendingRes,
        retryExhaustedRes,
        checkpointRes,
      ] = await Promise.all([
        supabase
          .from("pending_product_syncs")
          .select("product_id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("reason", "images"),
        supabase
          .from("pending_product_syncs")
          .select("reason")
          .eq("tenant_id", tenantId),
        supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .not("images", "is", null)
          .neq("images", "[]"),
        supabase
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("type", "SYNC_TO_WOO")
          .in("state", ["ready", "processing"]),
        supabase
          .from("changelog")
          .select("event_type, description, metadata, created_at")
          .eq("tenant_id", tenantId)
          .gte("created_at", new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
          .or("event_type.eq.WOO_PRODUCT_PUSH,event_type.eq.WOO_IMAGE_UPLOAD_FAILED,event_type.eq.IMAGE_RETRY_BATCH")
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("products")
          .select("id, woo_products!inner(id)", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .not("images", "is", null)
          .neq("images", "[]"),
        supabase
          .from("image_sync_status")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "uploaded"),
        supabase
          .from("image_sync_status")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "confirmed"),
        supabase
          .from("image_sync_status")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "failed"),
        supabase
          .from("image_sync_status")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "pending"),
        supabase
          .from("image_sync_status")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "failed")
          .gte("retry_count", 5),
        // Checkpoint
        supabase
          .from("config")
          .select("value")
          .eq("key", `image_sync_checkpoint_${tenantId}`)
          .maybeSingle(),
      ]);

      const reasonCounts: Record<string, number> = {};
      for (const row of pendingByReasonRes.data || []) {
        reasonCounts[row.reason] = (reasonCounts[row.reason] || 0) + 1;
      }

      let imageFailures = 0;
      let imagePushes = 0;
      for (const log of recentLogsRes.data || []) {
        if (log.event_type === "WOO_IMAGE_UPLOAD_FAILED") imageFailures++;
        if (log.event_type === "WOO_PRODUCT_PUSH") imagePushes++;
      }

      const checkpoint = checkpointRes.data?.value as {
        offset: number; total: number; processed: number; updated: number;
        errors: number; started_at: string; last_batch_at: string;
      } | null;

      return {
        pendingImages: pendingRes.count ?? 0,
        pendingByReason: reasonCounts,
        productsWithImages: productsWithImagesRes.count ?? 0,
        linkedWithImages: linkedWithImagesRes.count ?? 0,
        activeJobs: activeJobsRes.count ?? 0,
        imageFailures,
        imagePushes,
        recentLogs: recentLogsRes.data || [],
        syncStatus: {
          uploaded: statusUploadedRes.count ?? 0,
          confirmed: statusConfirmedRes.count ?? 0,
          failed: statusFailedRes.count ?? 0,
          pending: statusPendingRes.count ?? 0,
        },
        retryExhausted: retryExhaustedRes.count ?? 0,
        checkpoint,
      };
    },
    enabled: !!tenantId,
    refetchInterval: 10000,
  });

  const handleRetryFailed = async (forceAll = false) => {
    setRetrying(true);
    try {
      const { data, error } = await supabase.functions.invoke("retry-image-sync", {
        body: { tenantId, forceAll },
      });
      if (error) throw error;
      toast.success(`${data.retried} items opnieuw ingepland${data.exhausted > 0 ? `, ${data.exhausted} definitief mislukt` : ""}`);
      refetch();
    } catch (err: any) {
      toast.error(`Retry mislukt: ${err.message}`);
    } finally {
      setRetrying(false);
    }
  };

  const handleResume = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-woo-images", {
        body: { tenantId, resume: true, dryRun: false },
      });
      if (error) throw error;
      const s = data?.summary;
      toast.success(
        `Batch verwerkt: ${s?.processed || 0} producten (${s?.updated || 0} bijgewerkt).${s?.nextOffset ? " Meer batches beschikbaar." : " Klaar!"}`,
      );
      refetch();
    } catch (err: any) {
      toast.error(`Sync mislukt: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleResetCheckpoint = async () => {
    try {
      await supabase.functions.invoke("sync-woo-images", {
        body: { tenantId, resetCheckpoint: true },
      });
      toast.success("Checkpoint gereset");
      refetch();
    } catch (err: any) {
      toast.error(`Reset mislukt: ${err.message}`);
    }
  };

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

  const totalTracked = stats.syncStatus.uploaded + stats.syncStatus.confirmed + stats.syncStatus.failed + stats.syncStatus.pending;
  const confirmedPct = totalTracked > 0 ? Math.round((stats.syncStatus.confirmed / totalTracked) * 100) : 0;
  const retryableFailed = stats.syncStatus.failed - stats.retryExhausted;

  return (
    <div className="space-y-4">
      {/* Manual media sync by SKU */}
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" />
            Handmatige Media Sync per SKU
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const sku = manualSku.trim();
              if (!sku) return;
              setManualSyncing(true);
              try {
                // Look up product by SKU
                const { data: product, error: lookupErr } = await supabase
                  .from("products")
                  .select("id, sku, title, images")
                  .eq("tenant_id", tenantId)
                  .eq("sku", sku)
                  .maybeSingle();
                if (lookupErr) throw lookupErr;
                if (!product) {
                  toast.error(`Product met SKU "${sku}" niet gevonden`);
                  return;
                }
                const imgCount = Array.isArray(product.images) ? product.images.length : 0;
                if (imgCount === 0) {
                  toast.error(`Product ${sku} (${product.title}) heeft geen afbeeldingen in het PIM`);
                  return;
                }
                // Trigger media push
                const { data, error } = await supabase.functions.invoke("push-to-woocommerce", {
                  body: { tenantId, productId: product.id, scope: "MEDIA" },
                });
                if (error) throw error;
                toast.success(`Media sync gestart voor ${sku} (${product.title}) — ${imgCount} afbeeldingen`, {
                  description: data?.message || "Push naar WooCommerce gestart",
                });
                setManualSku("");
                refetch();
              } catch (err: any) {
                toast.error(`Media sync mislukt: ${err.message}`);
              } finally {
                setManualSyncing(false);
              }
            }}
          >
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Voer SKU in (bijv. 233768605000)…"
                value={manualSku}
                onChange={(e) => setManualSku(e.target.value)}
                className="pl-9"
                disabled={manualSyncing}
              />
            </div>
            <Button type="submit" size="sm" disabled={manualSyncing || !manualSku.trim()}>
              {manualSyncing ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Image className="h-4 w-4 mr-1.5" />}
              Sync Media
            </Button>
          </form>
          <p className="text-xs text-muted-foreground mt-2">
            Pusht alle afbeeldingen van het opgegeven product direct naar WooCommerce.
          </p>
        </CardContent>
      </Card>

      {/* Checkpoint resume card */}
      {stats.checkpoint && (
        <Card className="card-elevated border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Play className="h-4 w-4 text-primary" />
              Onderbroken Sync — Hervat beschikbaar
              <Badge variant="secondary" className="text-[10px] ml-auto">
                {stats.checkpoint.processed} / {stats.checkpoint.total}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress
              value={stats.checkpoint.total > 0 ? Math.round((stats.checkpoint.processed / stats.checkpoint.total) * 100) : 0}
              className="h-2"
            />
            <div className="grid gap-3 sm:grid-cols-4">
              <MiniStat label="Verwerkt" value={stats.checkpoint.processed} color="text-primary" />
              <MiniStat label="Bijgewerkt" value={stats.checkpoint.updated} color="text-success" />
              <MiniStat label="Fouten" value={stats.checkpoint.errors} color="text-destructive" />
              <MiniStat label="Resterend" value={stats.checkpoint.total - stats.checkpoint.processed} color="text-muted-foreground" />
            </div>
            <p className="text-xs text-muted-foreground">
              Gestart {new Date(stats.checkpoint.started_at).toLocaleString("nl-NL")} — 
              laatste batch {new Date(stats.checkpoint.last_batch_at).toLocaleTimeString("nl-NL")}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleResume}
                disabled={syncing}
              >
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
                Hervat sync
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleResetCheckpoint}
                disabled={syncing}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Reset checkpoint
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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

      {/* Retry failed panel */}
      {stats.syncStatus.failed > 0 && (
        <Card className="card-elevated border-destructive/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Mislukte Image Syncs
              <Badge variant="destructive" className="text-[10px] ml-auto">{stats.syncStatus.failed}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniStat label="Retrybaar" value={retryableFailed} color="text-warning" />
              <MiniStat label="Uitgeput (5x)" value={stats.retryExhausted} color="text-destructive" icon={XCircle} />
              <MiniStat label="Max retries" value={5} color="text-muted-foreground" />
            </div>
            <p className="text-xs text-muted-foreground">
              Exponentiële backoff: 1min → 2min → 4min → 8min → 16min. Items die 5× mislukken worden als definitief mislukt gemarkeerd.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRetryFailed(false)}
                disabled={retrying || retryableFailed === 0}
              >
                {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RotateCcw className="h-3.5 w-3.5 mr-1.5" />}
                Retry eligible ({retryableFailed})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleRetryFailed(true)}
                disabled={retrying || stats.syncStatus.failed === 0}
              >
                Force retry alles
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Image sync status tracking */}
      {totalTracked > 0 && (
        <Card className="card-elevated">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Image Upload Verificatie
              <Badge variant="outline" className="text-[10px] ml-auto">Push + Webhook</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <MiniStat label="Push Bevestigd" value={stats.syncStatus.uploaded} color="text-primary" />
              <MiniStat label="Webhook Bevestigd" value={stats.syncStatus.confirmed} color="text-success" icon={Webhook} />
              <MiniStat label="Mislukt" value={stats.syncStatus.failed} color="text-destructive" />
              <MiniStat label="In Afwachting" value={stats.syncStatus.pending} color="text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Webhook bevestiging</span>
                <span className="font-medium">{confirmedPct}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden flex">
                <div
                  className="h-full bg-success transition-all"
                  style={{ width: `${totalTracked > 0 ? (stats.syncStatus.confirmed / totalTracked) * 100 : 0}%` }}
                />
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${totalTracked > 0 ? (stats.syncStatus.uploaded / totalTracked) * 100 : 0}%` }}
                />
                <div
                  className="h-full bg-destructive transition-all"
                  style={{ width: `${totalTracked > 0 ? (stats.syncStatus.failed / totalTracked) * 100 : 0}%` }}
                />
              </div>
              <div className="flex gap-4 text-[10px] text-muted-foreground pt-1">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" />Webhook OK</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" />Push OK</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-destructive" />Mislukt</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
                const isRetry = log.event_type === "IMAGE_RETRY_BATCH";
                const meta = log.metadata as any;
                return (
                  <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isError ? (
                        <XCircle className="h-3 w-3 text-destructive flex-shrink-0" />
                      ) : isRetry ? (
                        <RotateCcw className="h-3 w-3 text-warning flex-shrink-0" />
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

      {/* Webhook setup info */}
      <Card className="card-elevated border-dashed">
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <Webhook className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Webhook Configuratie</p>
              <p className="text-xs text-muted-foreground">
                Configureer een WooCommerce webhook met topic <code className="bg-muted px-1 py-0.5 rounded text-[10px]">Product updated</code> naar 
                het endpoint <code className="bg-muted px-1 py-0.5 rounded text-[10px]">woo-media-webhook</code> voor automatische bevestiging van afbeelding uploads.
                Gebruik hetzelfde webhook secret als het order webhook.
              </p>
            </div>
          </div>
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

function MiniStat({ label, value, color, icon: Icon }: {
  label: string; value: number; color: string; icon?: typeof Webhook;
}) {
  return (
    <div className="text-center p-2 rounded-lg bg-muted/30">
      <div className={`text-xl font-bold ${color} flex items-center justify-center gap-1`}>
        {Icon && <Icon className="h-4 w-4" />}
        {value}
      </div>
      <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}
