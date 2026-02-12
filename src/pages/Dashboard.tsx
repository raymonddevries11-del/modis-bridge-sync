import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useNavigate } from "react-router-dom";
import { calculateCompleteness } from "@/lib/completeness";
import {
  Package, ShoppingCart, Activity, AlertCircle, CheckCircle2,
  Clock, Server, Send, Rss, ArrowRight, Zap, TrendingUp,
  AlertTriangle, RefreshCw,
} from "lucide-react";

// --- Helpers ---
function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "zojuist";
  if (mins < 60) return `${mins}m geleden`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}u geleden`;
  const days = Math.floor(hours / 24);
  return `${days}d geleden`;
}

const stateIcon: Record<string, { icon: typeof CheckCircle2; cls: string }> = {
  done: { icon: CheckCircle2, cls: "text-success" },
  processing: { icon: RefreshCw, cls: "text-primary animate-spin" },
  error: { icon: AlertCircle, cls: "text-destructive" },
  ready: { icon: Clock, cls: "text-muted-foreground" },
};

const Dashboard = () => {
  const navigate = useNavigate();

  // --- Data queries ---
  const { data: stats } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const [products, orders, jobs, configResult] = await Promise.all([
        supabase.from("products").select("id", { count: "exact", head: true }),
        supabase.from("orders").select("order_number", { count: "exact", head: true }),
        supabase.from("jobs").select("state,type,updated_at", { count: "exact" }),
        supabase.from("config").select("value").eq("key", "woocommerce").maybeSingle(),
      ]);

      const config = configResult.data;
      const jobsByState = jobs.data?.reduce((acc, job) => {
        acc[job.state] = (acc[job.state] || 0) + 1;
        return acc;
      }, {} as Record<string, number>) || {};

      const syncJobs = jobs.data?.filter((j) => j.type === "SYNC_TO_WOO" && j.state === "done") || [];
      const lastSync = syncJobs.length > 0
        ? syncJobs.reduce((latest, job) => new Date(job.updated_at) > new Date(latest.updated_at) ? job : latest).updated_at
        : null;

      return {
        totalProducts: products.count || 0,
        totalOrders: orders.count || 0,
        pendingJobs: jobsByState.ready || 0,
        processingJobs: jobsByState.processing || 0,
        failedJobs: jobsByState.error || 0,
        completedJobs: jobsByState.done || 0,
        wooCommerceConnected: !!config?.value,
        lastWooCommerceSync: lastSync,
      };
    },
    refetchInterval: 5000,
  });

  const { data: recentJobs } = useQuery({
    queryKey: ["recent-jobs"],
    queryFn: async () => {
      const { data } = await supabase.from("jobs").select("*").order("created_at", { ascending: false }).limit(8);
      return data || [];
    },
    refetchInterval: 5000,
  });

  const { data: recentChangelog } = useQuery({
    queryKey: ["recent-changelog"],
    queryFn: async () => {
      const { data } = await supabase.from("changelog").select("*").order("created_at", { ascending: false }).limit(6);
      return data || [];
    },
    refetchInterval: 10000,
  });

  const { data: completenessStats } = useQuery({
    queryKey: ["completeness-stats"],
    queryFn: async () => {
      const { data } = await supabase
        .from("products")
        .select("*, brands(id, name), suppliers(id, name), product_prices(*), variants(*, stock_totals(*))")
        .limit(500);
      if (!data) return { avg: 0, complete: 0, warning: 0, critical: 0, total: 0 };
      const scores = data.map((p) => calculateCompleteness(p).score);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      return {
        avg,
        complete: scores.filter((s) => s >= 80).length,
        warning: scores.filter((s) => s >= 50 && s < 80).length,
        critical: scores.filter((s) => s < 50).length,
        total: scores.length,
      };
    },
  });

  const { data: pendingSyncs } = useQuery({
    queryKey: ["pending-syncs-count"],
    queryFn: async () => {
      const { count } = await supabase.from("pending_product_syncs").select("product_id", { count: "exact", head: true });
      return count || 0;
    },
    refetchInterval: 10000,
  });

  return (
    <Layout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1>Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">Modis Bridge — overzicht van je integratie</p>
        </div>

        {/* KPI Row */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <KPICard icon={Package} label="Producten" value={stats?.totalProducts || 0} onClick={() => navigate("/products")} accent="primary" />
          <KPICard icon={ShoppingCart} label="Orders" value={stats?.totalOrders || 0} onClick={() => navigate("/orders")} accent="success" />
          <KPICard icon={Activity} label="Jobs in wachtrij" value={(stats?.pendingJobs || 0) + (stats?.processingJobs || 0)} onClick={() => navigate("/activity")} accent="warning" sub={stats?.processingJobs ? `${stats.processingJobs} actief` : undefined} />
          <KPICard icon={AlertCircle} label="Mislukte jobs" value={stats?.failedJobs || 0} onClick={() => navigate("/activity")} accent="destructive" sub={stats?.failedJobs ? "Aandacht vereist" : "Alles OK"} />
        </div>

        {/* Middle row: Channel health + Completeness */}
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Channel Health */}
          <Card className="card-elevated lg:col-span-2">
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-primary" /> Channel Health</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-3 gap-4">
                {/* WooCommerce */}
                <ChannelCard
                  icon={Send}
                  name="WooCommerce"
                  connected={stats?.wooCommerceConnected || false}
                  lastSync={stats?.lastWooCommerceSync}
                  pendingSyncs={pendingSyncs || 0}
                  onClick={() => navigate("/channels/woocommerce")}
                />
                {/* Google Shopping */}
                <ChannelCard
                  icon={Rss}
                  name="Google Shopping"
                  connected={true}
                  onClick={() => navigate("/channels/google")}
                />
                {/* SFTP */}
                <div className="rounded-xl border border-border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">SFTP</span>
                    <span className="badge-success ml-auto">Actief</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Auto-scheduler elke 2 minuten</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Completeness Overview */}
          <Card className="card-elevated">
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" /> Data Kwaliteit</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Big score */}
              <div className="flex items-center gap-4">
                <div className={`h-16 w-16 rounded-2xl flex items-center justify-center text-lg font-bold ${(completenessStats?.avg ?? 0) >= 80 ? "bg-success/15 text-success" : (completenessStats?.avg ?? 0) >= 50 ? "bg-warning/15 text-warning" : "bg-destructive/15 text-destructive"}`}>
                  {completenessStats?.avg ?? 0}%
                </div>
                <div>
                  <p className="text-sm font-medium">Gemiddelde score</p>
                  <p className="text-xs text-muted-foreground">{completenessStats?.total ?? 0} producten geanalyseerd</p>
                </div>
              </div>
              {/* Breakdown */}
              <div className="space-y-2">
                <ScoreBar label="Compleet (≥80%)" count={completenessStats?.complete ?? 0} total={completenessStats?.total || 1} color="bg-success" />
                <ScoreBar label="Aandacht (50-79%)" count={completenessStats?.warning ?? 0} total={completenessStats?.total || 1} color="bg-warning" />
                <ScoreBar label="Kritiek (<50%)" count={completenessStats?.critical ?? 0} total={completenessStats?.total || 1} color="bg-destructive" />
              </div>
              <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => navigate("/products")}>
                Bekijk producten <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Bottom row: Activity Feed + Job Queue */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Activity Feed (Intercom-style) */}
          <Card className="card-elevated">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Recente Activiteit</CardTitle>
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => navigate("/activity")}>
                  Alles bekijken <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />
                <div className="space-y-0">
                  {recentChangelog && recentChangelog.length > 0 ? (
                    recentChangelog.map((entry) => (
                      <div key={entry.id} className="relative flex gap-4 py-3">
                        <div className="relative z-10 flex-shrink-0 h-6 w-6 rounded-full bg-accent flex items-center justify-center">
                          <ActivityIcon type={entry.event_type} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm">{entry.description}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{timeAgo(entry.created_at)}</p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground pl-10 py-4">Geen recente activiteit</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Job Queue */}
          <Card className="card-elevated">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Job Queue</CardTitle>
                <div className="flex items-center gap-2">
                  {(stats?.processingJobs || 0) > 0 && <span className="badge-info">{stats?.processingJobs} actief</span>}
                  <Button variant="ghost" size="sm" className="text-xs" onClick={() => navigate("/activity")}>
                    Alles <ArrowRight className="h-3 w-3 ml-1" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Summary strip */}
              <div className="flex items-center gap-3 mb-4 p-2.5 rounded-lg bg-muted/50 text-xs">
                <span className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> {stats?.completedJobs || 0}</span>
                <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-muted-foreground" /> {stats?.pendingJobs || 0}</span>
                <span className="flex items-center gap-1"><Activity className="h-3.5 w-3.5 text-primary" /> {stats?.processingJobs || 0}</span>
                <span className="flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5 text-destructive" /> {stats?.failedJobs || 0}</span>
              </div>
              {/* Job list */}
              <div className="space-y-0.5">
                {recentJobs && recentJobs.length > 0 ? (
                  recentJobs.map((job) => {
                    const si = stateIcon[job.state] || stateIcon.ready;
                    const Icon = si.icon;
                    return (
                      <div key={job.id} className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-0">
                        <Icon className={`h-4 w-4 flex-shrink-0 ${si.cls}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{job.type.replace(/_/g, " ")}</p>
                          <p className="text-[11px] text-muted-foreground">{timeAgo(job.created_at)}</p>
                        </div>
                        <span className={`text-[11px] font-medium ${job.state === "done" ? "text-success" : job.state === "error" ? "text-destructive" : job.state === "processing" ? "text-primary" : "text-muted-foreground"}`}>
                          {job.state}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-sm text-muted-foreground py-4">Geen recente jobs</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
};

// --- Sub-components ---

function KPICard({ icon: Icon, label, value, onClick, accent, sub }: {
  icon: typeof Package; label: string; value: number; onClick: () => void; accent: string; sub?: string;
}) {
  return (
    <Card className="card-interactive cursor-pointer" onClick={onClick}>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center bg-${accent}/10`}>
            <Icon className={`h-5 w-5 text-${accent}`} />
          </div>
          <span className="text-2xl font-bold">{value.toLocaleString()}</span>
        </div>
        <p className="text-sm text-muted-foreground mt-2">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function ChannelCard({ icon: Icon, name, connected, lastSync, pendingSyncs, onClick }: {
  icon: typeof Send; name: string; connected: boolean; lastSync?: string | null; pendingSyncs?: number; onClick: () => void;
}) {
  return (
    <div className="rounded-xl border border-border p-4 space-y-3 cursor-pointer hover:border-primary/20 transition-colors" onClick={onClick}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{name}</span>
        {connected ? <span className="badge-success ml-auto">Verbonden</span> : <span className="badge-warning ml-auto">Niet verbonden</span>}
      </div>
      {lastSync && <p className="text-[11px] text-muted-foreground">Laatste sync: {timeAgo(lastSync)}</p>}
      {(pendingSyncs ?? 0) > 0 && <p className="text-[11px] text-warning">{pendingSyncs} pending syncs</p>}
    </div>
  );
}

function ScoreBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = Math.round((count / total) * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{count}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ActivityIcon({ type }: { type: string }) {
  if (type.includes("sync") || type.includes("SYNC")) return <RefreshCw className="h-3 w-3 text-primary" />;
  if (type.includes("import") || type.includes("IMPORT")) return <Package className="h-3 w-3 text-success" />;
  if (type.includes("error") || type.includes("ERROR")) return <AlertTriangle className="h-3 w-3 text-destructive" />;
  return <Activity className="h-3 w-3 text-muted-foreground" />;
}

export default Dashboard;
