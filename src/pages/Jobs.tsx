import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { TenantSelector } from "@/components/TenantSelector";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState, useEffect } from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";

const Jobs = () => {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectedTenant, setSelectedTenant] = useState<string>("all");
  const queryClient = useQueryClient();

  // Auto-select first active tenant
  const { data: tenants } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("*")
        .eq("active", true)
        .order("name");
      return data || [];
    },
  });

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["jobs", statusFilter, typeFilter, selectedTenant],
    queryFn: async () => {
      let query = supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false });

      if (selectedTenant !== "all") {
        query = query.eq("tenant_id", selectedTenant);
      }

      if (statusFilter !== "all") {
        query = query.eq("state", statusFilter as "ready" | "processing" | "done" | "error");
      }

      if (typeFilter !== "all") {
        query = query.eq("type", typeFilter);
      }

      const { data } = await query.limit(100);
      return data || [];
    },
    refetchInterval: 5000,
  });

  const retryJobMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const { error } = await supabase
        .from("jobs")
        .update({
          state: "ready",
          attempts: 0,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Job queued for retry");
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error: any) => {
      toast.error(`Failed to retry job: ${error.message}`);
    },
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
          <h1 className="text-3xl font-bold tracking-tight">Jobs Queue</h1>
          <p className="text-muted-foreground">
            Monitor background processing jobs
          </p>
        </div>

        <div className="flex items-center gap-4">
          <Select value={selectedTenant} onValueChange={setSelectedTenant}>
            <SelectTrigger className="w-[250px]">
              <SelectValue placeholder="Filter by tenant" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tenants</SelectItem>
              {tenants?.map((tenant) => (
                <SelectItem key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              <SelectItem value="ready">Ready</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="done">Done</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Filter by type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="IMPORT_ARTICLES_XML">Article Import</SelectItem>
              <SelectItem value="EXPORT_ORDER_XML">Order Export</SelectItem>
              <SelectItem value="SYNC_TO_WOO">WooCommerce Sync</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading jobs...</p>
          </div>
        ) : jobs && jobs.length > 0 ? (
          <div className="space-y-3">
            {jobs.map((job: any) => (
              <Card key={job.id}>
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="grid md:grid-cols-5 gap-4 flex-1">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Type</p>
                        <p className="font-semibold">{job.type}</p>
                        {job.payload?.filename && (
                          <p className="text-xs text-muted-foreground mt-1">{job.payload.filename}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">State</p>
                        <Badge className={getJobStateColor(job.state)} variant="outline">
                          {job.state}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Attempts</p>
                        <p className="text-sm">{job.attempts}</p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Created</p>
                        <p className="text-sm">{new Date(job.created_at).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Updated</p>
                        <p className="text-sm">{new Date(job.updated_at).toLocaleString()}</p>
                      </div>
                    </div>
                    {job.state === 'error' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => retryJobMutation.mutate(job.id)}
                        disabled={retryJobMutation.isPending}
                      >
                        <RotateCw className="h-4 w-4 mr-2" />
                        Retry
                      </Button>
                    )}
                  </div>
                  {job.error && (
                    <div className="mt-4 pt-4 border-t">
                      <p className="text-sm font-medium text-destructive mb-2">Error Details</p>
                      <pre className="text-xs bg-destructive/5 p-3 rounded-md overflow-x-auto">
                        {job.error}
                      </pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">
                {statusFilter !== "all" ? `No ${statusFilter} jobs found` : "No jobs found"}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
};

export default Jobs;
