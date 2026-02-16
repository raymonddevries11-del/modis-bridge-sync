import { useState } from "react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Send, RefreshCw, CheckCircle2, Link2, Globe, Loader2, Package, ArrowUpDown, Unlink, AlertTriangle } from "lucide-react";
import { TenantSelector } from "@/components/TenantSelector";
import { UrlKeyAudit } from "@/components/woocommerce/UrlKeyAudit";
import { WooProductTable } from "@/components/woocommerce/WooProductTable";
import { WooDeltaDashboard } from "@/components/woocommerce/WooDeltaDashboard";
import { WooLinkStatus } from "@/components/woocommerce/WooLinkStatus";
import { FailedPushPanel } from "@/components/woocommerce/FailedPushPanel";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ChannelWooCommerce = () => {
  const [tenantId, setTenantId] = useState("");
  const [fixingKeys, setFixingKeys] = useState(false);
  const [syncingSlugs, setSyncingSlugs] = useState(false);
  const [fullSyncing, setFullSyncing] = useState(false);
  const [syncingMissing, setSyncingMissing] = useState(false);
  const navigate = useNavigate();

  // Fetch sync stats
  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ["woo-sync-stats", tenantId],
    queryFn: async () => {
      const [productsRes, syncedRes, pendingRes, activeJobsRes, recentJobsRes] = await Promise.all([
        supabase.from("products").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
        supabase.from("product_sync_status").select("product_id", { count: "exact", head: true }),
        supabase.from("pending_product_syncs").select("product_id", { count: "exact", head: true }).eq("tenant_id", tenantId),
        supabase.from("jobs").select("id", { count: "exact", head: true }).eq("type", "SYNC_TO_WOO").in("state", ["ready", "processing"]),
        supabase.from("jobs").select("id, state, created_at, updated_at, payload").eq("type", "SYNC_TO_WOO").order("created_at", { ascending: false }).limit(5),
      ]);
      return {
        totalProducts: productsRes.count ?? 0,
        syncedProducts: syncedRes.count ?? 0,
        pendingSyncs: pendingRes.count ?? 0,
        activeJobs: activeJobsRes.count ?? 0,
        recentJobs: recentJobsRes.data ?? [],
      };
    },
    enabled: !!tenantId,
    refetchInterval: 10000,
  });

  const createJob = async (type: string, label: string, setLoading: (v: boolean) => void) => {
    if (!tenantId) { toast.error("Selecteer eerst een tenant"); return; }
    setLoading(true);
    try {
      const { error } = await supabase.from("jobs").insert({
        type, state: "ready" as const, payload: { tenantId }, tenant_id: tenantId,
      });
      if (error) throw error;
      toast.success(`${label} job aangemaakt`, { action: { label: "Bekijk Jobs", onClick: () => navigate("/jobs") } });
      refetchStats();
    } catch (e: any) { toast.error(`Fout: ${e.message}`); }
    finally { setLoading(false); }
  };

  const handleFullSync = async () => {
    if (!tenantId) { toast.error("Selecteer eerst een tenant"); return; }
    setFullSyncing(true);
    try {
      const { data: products, error: productsError } = await supabase
        .from("products").select("id").eq("tenant_id", tenantId);
      if (productsError) throw productsError;
      if (!products || products.length === 0) { toast.error("Geen producten gevonden"); return; }

      const productIds = products.map(p => p.id);
      const BATCH_SIZE = 50;
      const jobs = [];
      for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
        jobs.push({ type: "SYNC_TO_WOO", state: "ready" as const, payload: { productIds: productIds.slice(i, i + BATCH_SIZE) }, tenant_id: tenantId });
      }
      const { error } = await supabase.from("jobs").insert(jobs);
      if (error) throw error;
      toast.success(`${jobs.length} sync jobs aangemaakt voor ${productIds.length} producten`, { action: { label: "Bekijk Jobs", onClick: () => navigate("/jobs") } });
      refetchStats();
    } catch (e: any) { toast.error(`Fout: ${e.message}`); }
    finally { setFullSyncing(false); }
  };

  const handleSyncMissing = async () => {
    if (!tenantId) { toast.error("Selecteer eerst een tenant"); return; }
    setSyncingMissing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-new-products", { body: { tenantId } });
      if (error) throw error;
      if (data?.new_products_found > 0) {
        toast.success(`${data.new_products_found} nieuwe producten gevonden, ${data.jobs_created} jobs aangemaakt`, { action: { label: "Bekijk Jobs", onClick: () => navigate("/jobs") } });
      } else { toast.info("Alle producten bestaan al in WooCommerce"); }
      refetchStats();
    } catch (e: any) { toast.error(`Fout: ${e.message}`); }
    finally { setSyncingMissing(false); }
  };

  const syncPercentage = stats ? Math.round((stats.syncedProducts / Math.max(stats.totalProducts, 1)) * 100) : 0;

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1>WooCommerce</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Beheer de synchronisatie met je WooCommerce webshop.
            </p>
          </div>
          <TenantSelector value={tenantId} onChange={setTenantId} />
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Producten in PIM</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5 text-primary" />
                <span className="text-2xl font-semibold">{stats?.totalProducts ?? "—"}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Gesynchroniseerd</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-success" />
                <span className="text-2xl font-semibold">{stats ? `${stats.syncedProducts} (${syncPercentage}%)` : "—"}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pending Syncs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <ArrowUpDown className="h-5 w-5 text-warning" />
                <span className="text-2xl font-semibold">{stats?.pendingSyncs ?? "0"}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Wijzigingen in wachtrij</p>
            </CardContent>
          </Card>
          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Actieve Jobs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                {stats?.activeJobs ? <Loader2 className="h-5 w-5 text-primary animate-spin" /> : <CheckCircle2 className="h-5 w-5 text-success" />}
                <span className="text-2xl font-semibold">{stats?.activeJobs ?? "0"}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">SYNC_TO_WOO jobs</p>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="delta" className="space-y-4">
          <TabsList>
            <TabsTrigger value="delta">Delta Tracking</TabsTrigger>
            <TabsTrigger value="products">WooCommerce Producten</TabsTrigger>
            <TabsTrigger value="link-status" className="flex items-center gap-1.5">
              <Unlink className="h-3.5 w-3.5" />
              Link Status
            </TabsTrigger>
            <TabsTrigger value="failed-pushes" className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Mislukte Pushes
            </TabsTrigger>
            <TabsTrigger value="actions">Acties & Tools</TabsTrigger>
          </TabsList>

          <TabsContent value="delta">
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base">Wijzigingen sinds laatste fetch</CardTitle>
              </CardHeader>
              <CardContent>
                {tenantId ? (
                  <WooDeltaDashboard tenantId={tenantId} />
                ) : (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Selecteer een tenant om delta data te bekijken.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="products">
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base">WooCommerce Productoverzicht</CardTitle>
              </CardHeader>
              <CardContent>
                {tenantId ? (
                  <WooProductTable tenantId={tenantId} />
                ) : (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Selecteer een tenant om producten te bekijken.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="link-status">
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base">SKU-based Link Status</CardTitle>
              </CardHeader>
              <CardContent>
                {tenantId ? (
                  <WooLinkStatus tenantId={tenantId} />
                ) : (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Selecteer een tenant om de link status te bekijken.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="failed-pushes">
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base">Mislukte WooCommerce Pushes</CardTitle>
              </CardHeader>
              <CardContent>
                {tenantId ? (
                  <FailedPushPanel tenantId={tenantId} />
                ) : (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    Selecteer een tenant om mislukte pushes te bekijken.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="actions" className="space-y-4">
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base">Sync Acties</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" size="sm" disabled={!tenantId || fullSyncing} onClick={handleFullSync}>
                    {fullSyncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    {fullSyncing ? "Bezig..." : "Full Sync"}
                  </Button>
                  <Button variant="outline" size="sm" disabled={!tenantId || syncingMissing} onClick={handleSyncMissing}>
                    {syncingMissing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                    {syncingMissing ? "Bezig..." : "Sync Missing Products"}
                  </Button>
                  <Button variant="outline" size="sm" disabled={!tenantId || fixingKeys} onClick={() => createJob("FIX_URL_KEYS", "Fix URL Keys", setFixingKeys)}>
                    <Link2 className="mr-2 h-4 w-4" />
                    {fixingKeys ? "Bezig..." : "Fix URL Keys"}
                  </Button>
                  <Button variant="outline" size="sm" disabled={!tenantId || syncingSlugs} onClick={() => createJob("SYNC_WOO_SLUGS", "Sync Slugs", setSyncingSlugs)}>
                    <Globe className="mr-2 h-4 w-4" />
                    {syncingSlugs ? "Bezig..." : "Sync alle Slugs"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Recent sync jobs */}
            {stats?.recentJobs && stats.recentJobs.length > 0 && (
              <Card className="card-elevated">
                <CardHeader>
                  <CardTitle className="text-base">Recente Sync Jobs</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {stats.recentJobs.map((job: any) => {
                      const productCount = job.payload?.productIds?.length ?? job.payload?.variantIds?.length ?? 0;
                      return (
                        <div key={job.id} className="flex items-center justify-between text-sm border rounded-lg p-3">
                          <div className="flex items-center gap-3">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              job.state === "done" ? "bg-success/10 text-success" :
                              job.state === "error" ? "bg-destructive/10 text-destructive" :
                              job.state === "processing" ? "bg-primary/10 text-primary" :
                              "bg-muted text-muted-foreground"
                            }`}>{job.state}</span>
                            <span className="text-muted-foreground">{productCount} producten</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {new Date(job.created_at).toLocaleString("nl-NL")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            <UrlKeyAudit tenantId={tenantId} />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

export default ChannelWooCommerce;
