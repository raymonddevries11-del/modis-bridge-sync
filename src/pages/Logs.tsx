import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";
import { Clock, CheckCircle, XCircle, Loader2, FileText, Upload, Download } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

interface ChangelogEntry {
  id: string;
  event_type: string;
  description: string;
  created_at: string;
  metadata: any;
  tenant_id: string;
  tenants?: {
    name: string;
    slug: string;
  };
}

const Logs = () => {
  const [realtimeJobs, setRealtimeJobs] = useState<Job[]>([]);
  const [realtimeChangelog, setRealtimeChangelog] = useState<ChangelogEntry[]>([]);

  const { data: jobs, isLoading: jobsLoading } = useQuery({
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

  const { data: changelog, isLoading: changelogLoading } = useQuery({
    queryKey: ["changelog"],
    queryFn: async () => {
      const { data } = await supabase
        .from("changelog")
        .select("*, tenants!inner(name, slug)")
        .order("created_at", { ascending: false })
        .limit(100);
      return data as ChangelogEntry[] || [];
    },
  });

  // Realtime subscription for jobs
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

  // Realtime subscription for changelog
  useEffect(() => {
    const channel = supabase
      .channel('changelog-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'changelog'
        },
        (payload) => {
          console.log('Changelog change detected:', payload);
          setRealtimeChangelog(prev => [payload.new as ChangelogEntry, ...prev]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Merge realtime data
  const allJobs = [...realtimeJobs, ...(jobs || [])].reduce((acc, job) => {
    if (!acc.find(j => j.id === job.id)) {
      acc.push(job);
    }
    return acc;
  }, [] as Job[]);

  const allChangelog = [...realtimeChangelog, ...(changelog || [])].reduce((acc, entry) => {
    if (!acc.find(e => e.id === entry.id)) {
      acc.push(entry);
    }
    return acc;
  }, [] as ChangelogEntry[]);

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

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case 'SFTP_SYNC':
        return <Download className="h-4 w-4 text-blue-600" />;
      case 'SFTP_UPLOAD':
        return <Upload className="h-4 w-4 text-green-600" />;
      case 'SYNC_COMPLETED':
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      default:
        return <FileText className="h-4 w-4 text-gray-600" />;
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Logs</h1>
          <p className="text-muted-foreground">
            Live activity monitoring (updates automatically)
          </p>
        </div>

        <Tabs defaultValue="changelog" className="w-full">
          <TabsList>
            <TabsTrigger value="changelog">Activity Log</TabsTrigger>
            <TabsTrigger value="jobs">Background Jobs</TabsTrigger>
          </TabsList>

          <TabsContent value="changelog" className="space-y-3 mt-6">
            {changelogLoading ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground mt-4">Loading activity log...</p>
                </CardContent>
              </Card>
            ) : allChangelog.length > 0 ? (
              <div className="space-y-3">
                {allChangelog.map((entry) => (
                  <Card key={entry.id}>
                    <CardContent className="py-4">
                      <div className="flex items-start gap-3">
                        {getEventIcon(entry.event_type)}
                        <div className="space-y-1 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{entry.description}</span>
                            <Badge variant="outline">{entry.event_type}</Badge>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span>{entry.tenants?.name}</span>
                            <span>{new Date(entry.created_at).toLocaleString()}</span>
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
                    No activity yet. Events will appear here when GitHub Actions sync files.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="jobs" className="space-y-3 mt-6">
            {jobsLoading ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground mt-4">Loading jobs...</p>
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
                    No background jobs yet. Jobs will appear here when they are processed.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

export default Logs;
