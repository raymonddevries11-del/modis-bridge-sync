import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from "@/components/ui/tooltip";
import {
  CheckCircle2, XCircle, ShieldAlert, Send, Clock, TrendingUp, BarChart3,
} from "lucide-react";

interface PushHealthWidgetProps {
  tenantId?: string;
  compact?: boolean;
}

interface PushStats {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  blocked: number;
  successRate: number;
  last24hPushes: number;
  last24hErrors: number;
  last24hBlocked: number;
  lastPushAt: string | null;
  recentPushes: Array<{
    description: string;
    created_at: string;
    totals: { created: number; updated: number; skipped: number; errors: number };
  }>;
}

export const PushHealthWidget = ({ tenantId, compact = false }: PushHealthWidgetProps) => {
  const { data: stats } = useQuery({
    queryKey: ["push-health-stats", tenantId],
    queryFn: async (): Promise<PushStats> => {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      let changelogQuery = supabase
        .from("changelog")
        .select("description, metadata, created_at")
        .eq("event_type", "WOO_PRODUCT_PUSH")
        .gte("created_at", since24h)
        .order("created_at", { ascending: false })
        .limit(50);

      let wooQuery = supabase
        .from("woo_products")
        .select("id, last_push_changes, last_pushed_at")
        .not("last_push_changes", "is", null)
        .gte("last_pushed_at", since24h)
        .limit(500);

      if (tenantId) {
        changelogQuery = changelogQuery.eq("tenant_id", tenantId);
        wooQuery = wooQuery.eq("tenant_id", tenantId);
      }

      const [changelogRes, wooRes] = await Promise.all([changelogQuery, wooQuery]);

      const logs = changelogRes.data || [];
      const wooProducts = wooRes.data || [];

      // Aggregate totals from changelog metadata
      let total = 0, created = 0, updated = 0, skipped = 0, errors = 0;
      const recentPushes: PushStats["recentPushes"] = [];

      for (const log of logs) {
        const t = (log.metadata as any)?.totals;
        if (t) {
          total += (t.created || 0) + (t.updated || 0) + (t.skipped || 0) + (t.errors || 0);
          created += t.created || 0;
          updated += t.updated || 0;
          skipped += t.skipped || 0;
          errors += t.errors || 0;
          recentPushes.push({
            description: log.description,
            created_at: log.created_at,
            totals: t,
          });
        }
      }

      // Count blocked responses from woo_products.last_push_changes
      let blocked = 0;
      for (const wp of wooProducts) {
        const lpc = wp.last_push_changes as any;
        if (!lpc) continue;
        const msg = typeof lpc.message === "string" ? lpc.message.toLowerCase() : "";
        if (msg.includes("bot protection") || msg.includes("blocked") || msg.includes("html")) {
          blocked++;
        }
      }

      const successCount = created + updated;
      const successRate = total > 0 ? Math.round((successCount / total) * 100) : 100;

      return {
        total,
        created,
        updated,
        skipped,
        errors,
        blocked,
        successRate,
        last24hPushes: logs.length,
        last24hErrors: errors,
        last24hBlocked: blocked,
        lastPushAt: logs.length > 0 ? logs[0].created_at : null,
        recentPushes: recentPushes.slice(0, 5),
      };
    },
    refetchInterval: 15000,
  });

  if (!stats) return null;

  const rateColor = stats.successRate >= 90
    ? "text-success"
    : stats.successRate >= 70
      ? "text-warning"
      : "text-destructive";

  const rateBarColor = stats.successRate >= 90
    ? "bg-success"
    : stats.successRate >= 70
      ? "bg-warning"
      : "bg-destructive";

  if (compact) {
    return (
      <TooltipProvider>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium flex items-center gap-1.5">
              <BarChart3 className="h-3.5 w-3.5 text-primary" />
              Push Health
            </span>
            <span className={`text-lg font-bold ${rateColor}`}>{stats.successRate}%</span>
          </div>
          <Progress value={stats.successRate} className="h-1.5" />
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-success" />
              {stats.created + stats.updated}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="h-3 w-3 text-destructive" />
              {stats.errors}
            </span>
            {stats.blocked > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 cursor-help">
                    <ShieldAlert className="h-3 w-3 text-amber-500" />
                    {stats.blocked}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">{stats.blocked} geblokkeerd door SiteGround bot protection</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            WooCommerce Push Health
            <Badge variant="outline" className="ml-auto text-[10px]">24u</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Success rate */}
          <div className="flex items-center gap-4">
            <div className={`h-14 w-14 rounded-2xl flex items-center justify-center text-lg font-bold ${
              stats.successRate >= 90 ? "bg-success/15 text-success" :
              stats.successRate >= 70 ? "bg-warning/15 text-warning" :
              "bg-destructive/15 text-destructive"
            }`}>
              {stats.successRate}%
            </div>
            <div>
              <p className="text-sm font-medium">Success rate</p>
              <p className="text-xs text-muted-foreground">
                {stats.total} producten verwerkt in {stats.last24hPushes} pushes
              </p>
            </div>
          </div>

          {/* Breakdown bars */}
          <div className="space-y-2">
            <StatRow icon={CheckCircle2} iconClass="text-success" label="Aangemaakt" count={stats.created} total={stats.total} color="bg-success" />
            <StatRow icon={TrendingUp} iconClass="text-primary" label="Bijgewerkt" count={stats.updated} total={stats.total} color="bg-primary" />
            <StatRow icon={Clock} iconClass="text-muted-foreground" label="Ongewijzigd" count={stats.skipped} total={stats.total} color="bg-muted-foreground" />
            <StatRow icon={XCircle} iconClass="text-destructive" label="Fouten" count={stats.errors} total={stats.total} color="bg-destructive" />
            {stats.blocked > 0 && (
              <StatRow icon={ShieldAlert} iconClass="text-amber-500" label="Bot blocked" count={stats.blocked} total={stats.total} color="bg-amber-500" />
            )}
          </div>

          {/* Recent pushes */}
          {stats.recentPushes.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t">
              <p className="text-xs font-medium text-muted-foreground">Recente pushes</p>
              {stats.recentPushes.map((push, i) => {
                const hasErrors = push.totals.errors > 0;
                return (
                  <div key={i} className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5">
                      {hasErrors ? (
                        <XCircle className="h-3 w-3 text-destructive" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 text-success" />
                      )}
                      <span className="text-muted-foreground">
                        {push.totals.created + push.totals.updated} OK
                        {push.totals.errors > 0 && <span className="text-destructive ml-1">{push.totals.errors} fout</span>}
                      </span>
                    </div>
                    <span className="text-muted-foreground">
                      {new Date(push.created_at).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
};

function StatRow({ icon: Icon, iconClass, label, count, total, color }: {
  icon: typeof CheckCircle2; iconClass: string; label: string; count: number; total: number; color: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className={`h-3 w-3 ${iconClass}`} />
          {label}
        </span>
        <span className="font-medium">{count} <span className="text-muted-foreground font-normal">({pct}%)</span></span>
      </div>
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
