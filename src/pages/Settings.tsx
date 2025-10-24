import { Layout } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const Settings = () => {
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
                  <Input id="sftp-host" placeholder="sftp.example.com" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sftp-port">Port</Label>
                  <Input id="sftp-port" placeholder="22" type="number" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sftp-username">Username</Label>
                  <Input id="sftp-username" placeholder="modis_user" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sftp-key">Private Key Path</Label>
                  <Input id="sftp-key" placeholder="/path/to/private/key" />
                </div>
                <Button>Save SFTP Settings</Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>SFTP Paths</CardTitle>
                <CardDescription>
                  Configure directory paths for file processing
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2">
                  <Label htmlFor="inbound-path">Inbound Path</Label>
                  <Input id="inbound-path" placeholder="/sftp/modis_to_wp/ready" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="outbound-path">Outbound Path</Label>
                  <Input id="outbound-path" placeholder="/sftp/wp_to_modis/ready" />
                </div>
                <Button>Save Path Settings</Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="woocommerce" className="space-y-4">
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
                  <Input id="woo-url" placeholder="https://yourstore.com" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="woo-key">Consumer Key</Label>
                  <Input id="woo-key" placeholder="ck_..." />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="woo-secret">Consumer Secret</Label>
                  <Input id="woo-secret" type="password" placeholder="cs_..." />
                </div>
                <Button>Save WooCommerce Settings</Button>
              </CardContent>
            </Card>
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
                <div className="grid gap-2">
                  <Label htmlFor="api-name">Key Name</Label>
                  <Input id="api-name" placeholder="Production API Key" />
                </div>
                <Button>Generate New API Key</Button>
                <div className="pt-4 border-t">
                  <p className="text-sm text-muted-foreground">
                    No API keys configured yet. Generate one to get started.
                  </p>
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
