import { Layout } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSearchParams, Navigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Activity, Clock, CheckCircle2, AlertCircle, Trash2, RefreshCw } from "lucide-react";
import { format } from "date-fns";

const ActivityPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "jobs";

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1>Activity</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor jobs, bekijk logs en volg wijzigingen.
          </p>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => setSearchParams({ tab: v })}
          className="space-y-4"
        >
          <TabsList>
            <TabsTrigger value="jobs">Jobs</TabsTrigger>
            <TabsTrigger value="changelog">Changelog</TabsTrigger>
          </TabsList>

          <TabsContent value="jobs">
            <JobsTab />
          </TabsContent>
          <TabsContent value="changelog">
            <ChangelogTab />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

function JobsTab() {
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs-activity"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
    refetchInterval: 5000,
  });

  const stateIcon = (state: string) => {
    switch (state) {
      case "done": return <CheckCircle2 className="h-4 w-4 text-success" />;
      case "error": return <AlertCircle className="h-4 w-4 text-destructive" />;
      case "processing": return <RefreshCw className="h-4 w-4 text-primary animate-spin" />;
      default: return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Laden...</div>;

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-8 text-center">
        <Activity className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Geen jobs gevonden</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Type</th>
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Created</th>
            <th className="text-left px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="table-row-clean">
              <td className="px-4 py-2.5 flex items-center gap-2">
                {stateIcon(job.state)}
                <span className="capitalize">{job.state}</span>
              </td>
              <td className="px-4 py-2.5 font-mono text-xs">{job.type}</td>
              <td className="px-4 py-2.5 text-muted-foreground">
                {format(new Date(job.created_at), "dd MMM HH:mm")}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-xs truncate">
                {job.error || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangelogTab() {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["changelog-activity"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("changelog")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Laden...</div>;

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-8 text-center">
        <Activity className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Geen changelog entries</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-start gap-3 px-4 py-3 rounded-lg border border-border bg-card">
          <div className="mt-0.5">
            <div className="h-2 w-2 rounded-full bg-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm">{entry.description}</p>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary" className="text-[11px]">{entry.event_type}</Badge>
              <span className="text-xs text-muted-foreground">
                {format(new Date(entry.created_at), "dd MMM yyyy HH:mm")}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default ActivityPage;
