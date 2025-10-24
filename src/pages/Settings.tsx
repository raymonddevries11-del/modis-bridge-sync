import { Layout } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useForm } from "react-hook-form";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Copy, Loader2 } from "lucide-react";
import { useState } from "react";

interface SftpFormData {
  host: string;
  port: number;
  username: string;
  inboundPath: string;
  outboundPath: string;
}

interface WooCommerceFormData {
  url: string;
  consumerKey: string;
  consumerSecret: string;
}

interface ApiKeyFormData {
  name: string;
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

  const wooForm = useForm<WooCommerceFormData>({
    defaultValues: {
      url: "",
      consumerKey: "",
      consumerSecret: "",
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

  // Load WooCommerce settings
  useQuery({
    queryKey: ['settings', 'woocommerce'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('settings', {
        body: { action: 'get', key: 'woocommerce' },
      });
      if (error) throw error;
      if (data) {
        wooForm.reset(data);
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

  // Save WooCommerce settings
  const saveWooMutation = useMutation({
    mutationFn: async (data: WooCommerceFormData) => {
      const { error } = await supabase.functions.invoke('settings', {
        body: { action: 'save', key: 'woocommerce', value: data },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "WooCommerce settings saved successfully" });
      queryClient.invalidateQueries({ queryKey: ['settings', 'woocommerce'] });
    },
    onError: (error: any) => {
      toast({ title: "Error saving WooCommerce settings", description: error.message, variant: "destructive" });
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
            Configure SFTP, WooCommerce, and API settings
          </p>
        </div>

        <Tabs defaultValue="sftp" className="space-y-4">
          <TabsList>
            <TabsTrigger value="sftp">SFTP</TabsTrigger>
            <TabsTrigger value="woocommerce">WooCommerce</TabsTrigger>
            <TabsTrigger value="api">API Keys</TabsTrigger>
          </TabsList>

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

          <TabsContent value="woocommerce" className="space-y-4">
            <form onSubmit={wooForm.handleSubmit((data) => saveWooMutation.mutate(data))}>
              <Card>
                <CardHeader>
                  <CardTitle>WooCommerce API</CardTitle>
                  <CardDescription>
                    Configure WooCommerce REST API credentials
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-2">
                    <Label htmlFor="woo-url">Store URL</Label>
                    <Input id="woo-url" placeholder="https://yourstore.com" {...wooForm.register("url")} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="woo-key">Consumer Key</Label>
                    <Input id="woo-key" placeholder="ck_..." {...wooForm.register("consumerKey")} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="woo-secret">Consumer Secret</Label>
                    <Input id="woo-secret" type="password" placeholder="cs_..." {...wooForm.register("consumerSecret")} />
                  </div>
                  <Button type="submit" disabled={saveWooMutation.isPending}>
                    {saveWooMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save WooCommerce Settings
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
