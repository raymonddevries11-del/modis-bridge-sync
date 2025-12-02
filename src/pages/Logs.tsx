import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";
import { Clock, CheckCircle, XCircle, Loader2, FileText, Upload, Download, RefreshCw, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  metadata: {
    filesProcessed?: number;
    filesSkipped?: number;
    totalFiles?: number;
    [key: string]: any;
  };
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

  const { data: sftpActivity, isLoading: sftpLoading, refetch: refetchActivity } = useQuery({
    queryKey: ["sftp-activity"],
    queryFn: async () => {
      const { data } = await supabase
        .from("changelog")
        .select("*, tenants!inner(name, slug)")
        .in("event_type", ["SFTP_SYNC", "SFTP_UPLOAD", "STOCK_IMPORT", "STOCK_FULL_CORRECTION", "PRODUCTS_IMPORTED", "SYNC_COMPLETED"])
        .order("created_at", { ascending: false })
        .limit(100);
      return data as ChangelogEntry[] || [];
    },
    refetchInterval: 30000, // Auto-refresh every 30 seconds
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

  // Realtime subscription for SFTP activity
  useEffect(() => {
    const channel = supabase
      .channel('sftp-activity-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'changelog',
          filter: 'event_type=in.(SFTP_SYNC,SFTP_UPLOAD)'
        },
        (payload) => {
          console.log('SFTP activity detected:', payload);
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

  const allSftpActivity = [...realtimeChangelog, ...(sftpActivity || [])].reduce((acc, entry) => {
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
      case 'STOCK_IMPORT':
        return <Download className="h-4 w-4 text-purple-600" />;
      case 'STOCK_FULL_CORRECTION':
        return <Package className="h-4 w-4 text-indigo-600" />;
      case 'PRODUCTS_IMPORTED':
        return <Download className="h-4 w-4 text-orange-600" />;
      case 'SYNC_COMPLETED':
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      default:
        return <FileText className="h-4 w-4 text-gray-600" />;
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Import Logs</h1>
            <p className="text-muted-foreground">
              XML bestandsverwerking (producten & voorraad) - auto-refresh elke 30 sec
            </p>
          </div>
          <Button variant="outline" onClick={() => refetchActivity()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Ververs
          </Button>
        </div>

        <div className="space-y-3">
          {sftpLoading ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground mt-4">Loading SFTP activity...</p>
              </CardContent>
            </Card>
          ) : allSftpActivity.length > 0 ? (
            <div className="space-y-3">
              {allSftpActivity.map((entry) => (
                <Card key={entry.id}>
                  <CardContent className="py-4">
                     <div className="flex items-start gap-3">
                      {getEventIcon(entry.event_type)}
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{entry.description}</span>
                          <Badge variant="outline">{entry.event_type}</Badge>
                          {entry.metadata?.filesProcessed !== undefined && (
                            <Badge variant="secondary">
                              {entry.metadata.filesProcessed} bestanden verwerkt
                            </Badge>
                          )}
                          {entry.metadata?.filesSkipped !== undefined && entry.metadata.filesSkipped > 0 && (
                            <Badge variant="outline">
                              {entry.metadata.filesSkipped} overgeslagen
                            </Badge>
                          )}
                          {entry.metadata?.totalFiles !== undefined && entry.metadata.totalFiles === 0 && (
                            <Badge variant="outline">Geen bestanden</Badge>
                          )}
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
                  Nog geen import activiteit. XML bestanden worden elke 2 minuten gesynchroniseerd via GitHub Actions.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </Layout>
  );
};

export default Logs;
