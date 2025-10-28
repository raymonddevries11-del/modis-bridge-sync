import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";
import { Clock, CheckCircle, XCircle, Loader2 } from "lucide-react";

interface Job {
  id: string;
  type: string;
  state: string;
  tenant_id: string;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  payload: any;
}

const Logs = () => {
  const [realtimeJobs, setRealtimeJobs] = useState<Job[]>([]);

  const { data: jobs, isLoading } = useQuery({
    queryKey: ["logs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      return data as Job[] || [];
    },
  });

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('jobs-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'jobs'
        },
        (payload) => {
          console.log('Job change detected:', payload);
          
          if (payload.eventType === 'INSERT') {
            setRealtimeJobs(prev => [payload.new as Job, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setRealtimeJobs(prev => 
              prev.map(job => 
                job.id === payload.new.id ? payload.new as Job : job
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Merge realtime jobs with initial data
  const allJobs = [...realtimeJobs, ...(jobs || [])].reduce((acc, job) => {
    if (!acc.find(j => j.id === job.id)) {
      acc.push(job);
    }
    return acc;
  }, [] as Job[]);

  const getStateColor = (state: string) => {
    switch (state) {
      case 'done':
        return 'default';
      case 'processing':
        return 'secondary';
      case 'error':
        return 'destructive';
      case 'ready':
        return 'outline';
      default:
        return 'outline';
    }
  };

  const getStateIcon = (state: string) => {
    switch (state) {
      case 'done':
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      case 'processing':
        return <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />;
      case 'error':
        return <XCircle className="h-4 w-4 text-red-600" />;
      case 'ready':
        return <Clock className="h-4 w-4 text-yellow-600" />;
      default:
        return <Clock className="h-4 w-4" />;
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Logs</h1>
          <p className="text-muted-foreground">
            Live job processing activity (updates automatically)
          </p>
        </div>

        {isLoading ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-4">Loading logs...</p>
            </CardContent>
          </Card>
        ) : allJobs.length > 0 ? (
          <div className="space-y-3">
            {allJobs.map((job) => (
              <Card key={job.id}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1">
                      {getStateIcon(job.state)}
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{job.type}</span>
                          <Badge variant={getStateColor(job.state)}>
                            {job.state}
                          </Badge>
                          {job.attempts > 1 && (
                            <Badge variant="outline">
                              Attempt {job.attempts}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>
                            Created: {new Date(job.created_at).toLocaleString()}
                          </span>
                          <span>
                            Updated: {new Date(job.updated_at).toLocaleString()}
                          </span>
                        </div>
                        {job.error && (
                          <div className="mt-2 p-2 bg-destructive/10 rounded text-xs text-destructive">
                            {job.error}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No logs yet. Jobs will appear here when they are processed.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
};

export default Logs;
