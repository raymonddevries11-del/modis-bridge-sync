import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { StatCard } from "@/components/StatCard";
import { Package, ShoppingCart, Activity, AlertCircle, CheckCircle2, Clock, Server, Settings as SettingsIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";

const Dashboard = () => {
  const navigate = useNavigate();

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

      // Find last successful WooCommerce sync
      const syncJobs = jobs.data?.filter((j) => j.type === "SYNC_TO_WOO" && j.state === "done") || [];
      const lastSync = syncJobs.length > 0 
        ? syncJobs.reduce((latest, job) => 
            new Date(job.updated_at) > new Date(latest.updated_at) ? job : latest
          ).updated_at
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
      const { data } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10);
      return data || [];
    },
    refetchInterval: 5000,
  });

  const getJobStateColor = (state: string) => {
    switch (state) {
      case "done":
        return "bg-success/10 text-success border-success/20";
      case "processing":
        return "bg-primary/10 text-primary border-primary/20";
      case "error":
        return "bg-destructive/10 text-destructive border-destructive/20";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground">
              Monitor your Modis Bridge integration status
            </p>
          </div>
          <Button onClick={() => navigate("/settings")} size="lg">
            <SettingsIcon className="h-4 w-4" />
            Configure SFTP & WooCommerce
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Total Products"
            value={stats?.totalProducts || 0}
            icon={Package}
          />
          <StatCard
            title="Total Orders"
            value={stats?.totalOrders || 0}
            icon={ShoppingCart}
          />
          <StatCard
            title="Pending Jobs"
            value={stats?.pendingJobs || 0}
            icon={Clock}
          />
          <StatCard
            title="Failed Jobs"
            value={stats?.failedJobs || 0}
            icon={AlertCircle}
            description={stats?.failedJobs ? "Requires attention" : "All good"}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Server className="h-5 w-5" />
                SFTP Status
              </CardTitle>
              <CardDescription>Connection & file monitoring</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Connection</span>
                <Badge variant="default">Active</Badge>
              </div>
              <div className="space-y-1">
                <span className="text-sm font-medium">Auto-scheduler</span>
                <p className="text-xs text-muted-foreground">Running every 2 minutes</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Job Queue Status</CardTitle>
              <CardDescription>Current processing queue overview</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <span className="text-sm font-medium">Completed</span>
                </div>
                <span className="text-2xl font-bold">{stats?.completedJobs || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Processing</span>
                </div>
                <span className="text-2xl font-bold">{stats?.processingJobs || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Pending</span>
                </div>
                <span className="text-2xl font-bold">{stats?.pendingJobs || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  <span className="text-sm font-medium">Failed</span>
                </div>
                <span className="text-2xl font-bold">{stats?.failedJobs || 0}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>WooCommerce Sync</CardTitle>
              <CardDescription>Integration status</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Status</span>
                <Badge variant={stats?.wooCommerceConnected ? "default" : "secondary"}>
                  {stats?.wooCommerceConnected ? "Connected" : "Not configured"}
                </Badge>
              </div>
              {stats?.lastWooCommerceSync && (
                <div className="space-y-1">
                  <span className="text-sm font-medium">Last Sync</span>
                  <p className="text-xs text-muted-foreground">
                    {new Date(stats.lastWooCommerceSync).toLocaleString()}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Jobs</CardTitle>
              <CardDescription>Latest job processing activity</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentJobs && recentJobs.length > 0 ? (
                  recentJobs.slice(0, 5).map((job) => (
                    <div key={job.id} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{job.type}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(job.created_at).toLocaleString()}
                        </p>
                      </div>
                      <Badge className={getJobStateColor(job.state)} variant="outline">
                        {job.state}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No recent jobs</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
};

export default Dashboard;
