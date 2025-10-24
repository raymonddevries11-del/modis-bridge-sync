import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { StatCard } from "@/components/StatCard";
import { Package, ShoppingCart, Activity, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const Dashboard = () => {
  const { data: stats } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const [products, orders, jobs] = await Promise.all([
        supabase.from("products").select("id", { count: "exact", head: true }),
        supabase.from("orders").select("id", { count: "exact", head: true }),
        supabase.from("jobs").select("state", { count: "exact" }),
      ]);

      const jobsByState = jobs.data?.reduce((acc, job) => {
        acc[job.state] = (acc[job.state] || 0) + 1;
        return acc;
      }, {} as Record<string, number>) || {};

      return {
        totalProducts: products.count || 0,
        totalOrders: orders.count || 0,
        pendingJobs: jobsByState.ready || 0,
        processingJobs: jobsByState.processing || 0,
        failedJobs: jobsByState.error || 0,
        completedJobs: jobsByState.done || 0,
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
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Monitor your Modis Bridge integration status
          </p>
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

        <div className="grid gap-4 md:grid-cols-2">
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
