import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  created_at: string;
}

interface TenantConfig {
  tenant_id: string;
  woocommerce_url: string;
  woocommerce_consumer_key: string;
  woocommerce_consumer_secret: string;
  sftp_inbound_path: string;
  sftp_outbound_path: string;
}

export default function Tenants() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    slug: "",
    woocommerce_url: "",
    woocommerce_consumer_key: "",
    woocommerce_consumer_secret: "",
  });

  const queryClient = useQueryClient();

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Tenant[];
    },
  });

  const createTenant = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { data: tenant, error: tenantError } = await supabase
        .from("tenants")
        .insert({
          name: data.name,
          slug: data.slug,
          active: true,
        })
        .select()
        .single();

      if (tenantError) throw tenantError;

      const { error: configError } = await supabase
        .from("tenant_config")
        .insert({
          tenant_id: tenant.id,
          woocommerce_url: data.woocommerce_url,
          woocommerce_consumer_key: data.woocommerce_consumer_key,
          woocommerce_consumer_secret: data.woocommerce_consumer_secret,
          sftp_inbound_path: `/home/customer/www/developmentplatform.nl/public_html/${data.slug}/modis-to-wp`,
          sftp_outbound_path: `/home/customer/www/developmentplatform.nl/public_html/${data.slug}/wp-to-modis`,
        });

      if (configError) throw configError;
      return tenant;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tenant created successfully");
      setIsDialogOpen(false);
      resetForm();
    },
    onError: (error) => {
      toast.error(`Failed to create tenant: ${error.message}`);
    },
  });

  const updateTenant = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      const { error: tenantError } = await supabase
        .from("tenants")
        .update({
          name: data.name,
          slug: data.slug,
        })
        .eq("id", id);

      if (tenantError) throw tenantError;

      const { error: configError } = await supabase
        .from("tenant_config")
        .update({
          woocommerce_url: data.woocommerce_url,
          woocommerce_consumer_key: data.woocommerce_consumer_key,
          woocommerce_consumer_secret: data.woocommerce_consumer_secret,
          sftp_inbound_path: `/home/customer/www/developmentplatform.nl/public_html/${data.slug}/modis-to-wp`,
          sftp_outbound_path: `/home/customer/www/developmentplatform.nl/public_html/${data.slug}/wp-to-modis`,
        })
        .eq("tenant_id", id);

      if (configError) throw configError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tenant updated successfully");
      setIsDialogOpen(false);
      resetForm();
    },
    onError: (error) => {
      toast.error(`Failed to update tenant: ${error.message}`);
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from("tenants")
        .update({ active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tenant status updated");
    },
    onError: (error) => {
      toast.error(`Failed to update status: ${error.message}`);
    },
  });

  const deleteTenant = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tenants").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tenant deleted successfully");
    },
    onError: (error) => {
      toast.error(`Failed to delete tenant: ${error.message}`);
    },
  });

  const resetForm = () => {
    setFormData({
      name: "",
      slug: "",
      woocommerce_url: "",
      woocommerce_consumer_key: "",
      woocommerce_consumer_secret: "",
    });
    setEditingTenant(null);
  };

  const handleEdit = async (tenant: Tenant) => {
    const { data: config } = await supabase
      .from("tenant_config")
      .select("*")
      .eq("tenant_id", tenant.id)
      .single();

    setEditingTenant(tenant);
    setFormData({
      name: tenant.name,
      slug: tenant.slug,
      woocommerce_url: config?.woocommerce_url || "",
      woocommerce_consumer_key: config?.woocommerce_consumer_key || "",
      woocommerce_consumer_secret: config?.woocommerce_consumer_secret || "",
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingTenant) {
      updateTenant.mutate({ id: editingTenant.id, data: formData });
    } else {
      createTenant.mutate(formData);
    }
  };

  return (
    <Layout>
      <div className="p-6 space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">Tenants</h1>
            <p className="text-muted-foreground">Manage your WooCommerce stores</p>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={(open) => {
            setIsDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Add Tenant
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>{editingTenant ? "Edit" : "Add"} Tenant</DialogTitle>
                <DialogDescription>
                  Configure a new WooCommerce store with SFTP integration
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit}>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Business Name</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Koster Schoenmode"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="slug">Slug (for SFTP directory)</Label>
                    <Input
                      id="slug"
                      value={formData.slug}
                      onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                      placeholder="e.g., kosterschoenmode"
                      required
                    />
                    <p className="text-sm text-muted-foreground">
                      SFTP paths will be: public_html/{formData.slug}/wp-to-modis
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="woocommerce_url">WooCommerce URL</Label>
                    <Input
                      id="woocommerce_url"
                      type="url"
                      value={formData.woocommerce_url}
                      onChange={(e) => setFormData({ ...formData, woocommerce_url: e.target.value })}
                      placeholder="https://example.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="consumer_key">Consumer Key</Label>
                    <Input
                      id="consumer_key"
                      value={formData.woocommerce_consumer_key}
                      onChange={(e) => setFormData({ ...formData, woocommerce_consumer_key: e.target.value })}
                      placeholder="ck_..."
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="consumer_secret">Consumer Secret</Label>
                    <Input
                      id="consumer_secret"
                      type="password"
                      value={formData.woocommerce_consumer_secret}
                      onChange={(e) => setFormData({ ...formData, woocommerce_consumer_secret: e.target.value })}
                      placeholder="cs_..."
                      required
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createTenant.isPending || updateTenant.isPending}>
                    {editingTenant ? "Update" : "Create"} Tenant
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Tenants</CardTitle>
            <CardDescription>View and manage all connected stores</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p>Loading tenants...</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenants.map((tenant) => (
                    <TableRow key={tenant.id}>
                      <TableCell className="font-medium">{tenant.name}</TableCell>
                      <TableCell className="font-mono text-sm">{tenant.slug}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={tenant.active}
                            onCheckedChange={(active) => toggleActive.mutate({ id: tenant.id, active })}
                          />
                          <span className="text-sm">{tenant.active ? "Active" : "Inactive"}</span>
                        </div>
                      </TableCell>
                      <TableCell>{new Date(tenant.created_at).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEdit(tenant)}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              if (confirm(`Are you sure you want to delete ${tenant.name}?`)) {
                                deleteTenant.mutate(tenant.id);
                              }
                            }}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
