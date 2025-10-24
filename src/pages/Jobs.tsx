import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";

const Jobs = () => {
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["jobs", statusFilter],
    queryFn: async () => {
      let query = supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false });

      if (statusFilter !== "all") {
        query = query.eq("state", statusFilter as "ready" | "processing" | "done" | "error");
      }

      const { data } = await query.limit(100);
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
          <h1 className="text-3xl font-bold tracking-tight">Jobs Queue</h1>
          <p className="text-muted-foreground">
            Monitor background processing jobs
          </p>
        </div>

        <div className="flex items-center gap-4">
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
                  <div className="grid md:grid-cols-5 gap-4">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Type</p>
                      <p className="font-semibold">{job.type}</p>
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
