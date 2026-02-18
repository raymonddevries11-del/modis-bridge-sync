import { Layout } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Copy, Loader2, Zap } from "lucide-react";
import { useState } from "react";

interface SftpFormData {
  host: string;
  port: number;
  username: string;
  inboundPath: string;
  outboundPath: string;
}


interface ApiKeyFormData {
  name: string;
}

const WINDOW_OPTIONS = [
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '120', label: '2 minutes' },
  { value: '300', label: '5 minutes' },
  { value: '600', label: '10 minutes' },
];

const BATCH_OPTIONS = [
  { value: '10', label: '10 products' },
  { value: '25', label: '25 products' },
  { value: '50', label: '50 products' },
  { value: '100', label: '100 products' },
];

const MAX_QUEUE_OPTIONS = [
  { value: '5', label: '5 jobs' },
  { value: '10', label: '10 jobs' },
  { value: '20', label: '20 jobs' },
  { value: '50', label: '50 jobs' },
];

const MAX_DRAIN_OPTIONS = [
  { value: '100', label: '100 products' },
  { value: '200', label: '200 products' },
  { value: '500', label: '500 products' },
];

function BatchSyncConfig() {
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useQuery({
    queryKey: ['settings', 'batch_sync_config'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('settings', {
        body: { action: 'get', key: 'batch_sync_config' },
      });
      if (error) throw error;
      return (data as { window_seconds?: number; batch_size?: number; max_queue_size?: number; max_products_per_drain?: number }) || {};
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (value: { window_seconds: number; batch_size: number; max_queue_size: number; max_products_per_drain: number }) => {
      const { error } = await supabase.functions.invoke('settings', {
        body: { action: 'save', key: 'batch_sync_config', value },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Batch sync config saved' });
      queryClient.invalidateQueries({ queryKey: ['settings', 'batch_sync_config'] });
    },
    onError: (e: any) => {
      toast({ title: 'Error saving config', description: e.message, variant: 'destructive' });
    },
  });

  const drainMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('drain-pending-syncs');
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast({ title: `Drained ${data.drained} pending → ${data.jobs} jobs` });
    },
    onError: (e: any) => {
      toast({ title: 'Error draining', description: e.message, variant: 'destructive' });
    },
  });

  const windowSeconds = config?.window_seconds || 60;
  const batchSize = config?.batch_size || 50;
  const maxQueueSize = config?.max_queue_size || 10;
  const maxProductsPerDrain = config?.max_products_per_drain || 200;

  const save = (overrides: Partial<{ window_seconds: number; batch_size: number; max_queue_size: number; max_products_per_drain: number }>) =>
    saveMutation.mutate({ window_seconds: windowSeconds, batch_size: batchSize, max_queue_size: maxQueueSize, max_products_per_drain: maxProductsPerDrain, ...overrides });

  if (isLoading) return <Card><CardContent className="p-6"><Loader2 className="h-5 w-5 animate-spin" /></CardContent></Card>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" /> Batch Sync Configuration</CardTitle>
        <CardDescription>
          Price and stock changes are buffered and synced to WooCommerce in batches. Configure the batch window, size, and queue limits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Batch Window</Label>
            <Select value={String(windowSeconds)} onValueChange={(v) => save({ window_seconds: Number(v) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Changes within this window are grouped into a single sync job.</p>
          </div>
          <div className="space-y-2">
            <Label>Batch Size</Label>
            <Select value={String(batchSize)} onValueChange={(v) => save({ batch_size: Number(v) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {BATCH_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Max products per sync job.</p>
          </div>
          <div className="space-y-2">
            <Label>Max Queue Size</Label>
            <Select value={String(maxQueueSize)} onValueChange={(v) => save({ max_queue_size: Number(v) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MAX_QUEUE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Maximaal aantal actieve jobs in de wachtrij. Nieuwe jobs worden uitgesteld als dit limiet bereikt is.</p>
          </div>
          <div className="space-y-2">
            <Label>Max Products per Drain</Label>
            <Select value={String(maxProductsPerDrain)} onValueChange={(v) => save({ max_products_per_drain: Number(v) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MAX_DRAIN_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Max producten per drain-cyclus om overbelasting te voorkomen.</p>
          </div>
        </div>
        <div className="flex items-center gap-3 pt-2 border-t">
          <Button variant="outline" onClick={() => drainMutation.mutate()} disabled={drainMutation.isPending}>
            {drainMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
            Drain Pending Now
          </Button>
          <p className="text-xs text-muted-foreground">Manually flush all pending changes into sync jobs.</p>
        </div>
      </CardContent>
    </Card>
  );
}

const Settings = () => {
  const queryClient = useQueryClient();
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  const sftpForm = useForm<SftpFormData>({
    defaultValues: {
      host: "ssh.developmentplatform.nl",
      port: 18765,
      username: "u838-cexw8hzuw8l9",
      inboundPath: "/home/customer/www/developmentplatform.nl/public_html/kosterschoenmode/modis-to-wp",
      outboundPath: "/home/customer/www/developmentplatform.nl/public_html/kosterschoenmode/wp-to-modis",
    },
  });


  const apiKeyForm = useForm<ApiKeyFormData>({
    defaultValues: {
      name: "",
    },
  });

  // Load SFTP settings
  useQuery({
    queryKey: ['settings', 'sftp'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('settings', {
        body: { action: 'get', key: 'sftp' },
      });
      if (error) throw error;
      if (data) {
        sftpForm.reset(data);
      }
      return data;
    },
  });


  // Load API keys
  const { data: apiKeysData } = useQuery({
    queryKey: ['api-keys'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('api-keys', {
        body: { action: 'list' },
      });
      if (error) throw error;
      return data || [];
    },
  });

  // Save SFTP settings
  const saveSftpMutation = useMutation({
    mutationFn: async (data: SftpFormData) => {
      const { error } = await supabase.functions.invoke('settings', {
        body: { action: 'save', key: 'sftp', value: data },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "SFTP settings saved successfully" });
      queryClient.invalidateQueries({ queryKey: ['settings', 'sftp'] });
    },
    onError: (error: any) => {
      toast({ title: "Error saving SFTP settings", description: error.message, variant: "destructive" });
    },
  });


  // Generate API key
  const generateApiKeyMutation = useMutation({
    mutationFn: async (data: ApiKeyFormData) => {
      const { data: result, error } = await supabase.functions.invoke('api-keys', {
        method: 'POST',
        body: data,
      });
      if (error) throw error;
      return result;
    },
    onSuccess: (data) => {
      setGeneratedKey(data.key);
      apiKeyForm.reset();
      toast({ title: "API key generated successfully", description: "Make sure to copy it now, you won't be able to see it again." });
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (error: any) => {
      toast({ title: "Error generating API key", description: error.message, variant: "destructive" });
    },
  });

  // Delete API key
  const deleteApiKeyMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.functions.invoke('api-keys', {
        body: { action: 'delete', id },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "API key deleted successfully" });
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (error: any) => {
      toast({ title: "Error deleting API key", description: error.message, variant: "destructive" });
    },
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">
            Configure SFTP and API settings. WooCommerce settings are now managed per tenant on the Tenants page.
          </p>
        </div>

        <Tabs defaultValue="sync" className="space-y-4">
          <TabsList>
            <TabsTrigger value="sync">Sync</TabsTrigger>
            <TabsTrigger value="sftp">SFTP</TabsTrigger>
            <TabsTrigger value="api">API Keys</TabsTrigger>
          </TabsList>

          <TabsContent value="sync" className="space-y-4">
            <BatchSyncConfig />
          </TabsContent>

          <TabsContent value="sftp" className="space-y-4">
            <form onSubmit={sftpForm.handleSubmit((data) => saveSftpMutation.mutate(data))}>
              <Card>
                <CardHeader>
                  <CardTitle>SFTP Configuration</CardTitle>
                  <CardDescription>
                    Configure connection details for Modis SFTP server
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-2">
                    <Label htmlFor="sftp-host">Host</Label>
                    <Input id="sftp-host" placeholder="sftp.example.com" {...sftpForm.register("host")} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="sftp-port">Port</Label>
                    <Input id="sftp-port" placeholder="22" type="number" {...sftpForm.register("port", { valueAsNumber: true })} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="sftp-username">Username</Label>
                    <Input id="sftp-username" placeholder="modis_user" {...sftpForm.register("username")} />
                  </div>
                  <div className="p-3 border rounded-lg bg-muted/50">
                    <p className="text-sm text-muted-foreground">
                      Private key is stored securely as a secret. Configured via Lovable Secrets.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="inbound-path">Inbound Path</Label>
                    <Input id="inbound-path" placeholder="/sftp/modis_to_wp/ready" {...sftpForm.register("inboundPath")} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="outbound-path">Outbound Path</Label>
                    <Input id="outbound-path" placeholder="/sftp/wp_to_modis/ready" {...sftpForm.register("outboundPath")} />
                  </div>
                  <Button type="submit" disabled={saveSftpMutation.isPending}>
                    {saveSftpMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save SFTP Settings
                  </Button>
                </CardContent>
              </Card>
            </form>
          </TabsContent>


          <TabsContent value="api" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>API Keys</CardTitle>
                <CardDescription>
                  Manage API keys for external integrations
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form onSubmit={apiKeyForm.handleSubmit((data) => generateApiKeyMutation.mutate(data))} className="space-y-4">
                  <div className="grid gap-2">
                    <Label htmlFor="api-name">Key Name</Label>
                    <Input id="api-name" placeholder="Production API Key" {...apiKeyForm.register("name")} />
                  </div>
                  <Button type="submit" disabled={generateApiKeyMutation.isPending}>
                    {generateApiKeyMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Generate New API Key
                  </Button>
                </form>

                {generatedKey && (
                  <div className="p-4 border rounded-lg bg-muted/50">
                    <p className="text-sm font-medium mb-2">Your new API key (copy it now):</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 p-2 bg-background rounded text-xs break-all">{generatedKey}</code>
                      <Button size="sm" variant="outline" onClick={() => copyToClipboard(generatedKey)}>
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t space-y-2">
                  {apiKeysData && apiKeysData.length > 0 ? (
                    apiKeysData.map((key: any) => (
                      <div key={key.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div>
                          <p className="font-medium">{key.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Created: {new Date(key.created_at).toLocaleDateString()}
                            {key.last_used_at && ` • Last used: ${new Date(key.last_used_at).toLocaleDateString()}`}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => deleteApiKeyMutation.mutate(key.id)}
                          disabled={deleteApiKeyMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No API keys configured yet. Generate one to get started.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

export default Settings;
