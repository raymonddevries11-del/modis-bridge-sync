import { useState } from "react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Send, RefreshCw, CheckCircle2, Link2, Globe } from "lucide-react";
import { TenantSelector } from "@/components/TenantSelector";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

const ChannelWooCommerce = () => {
  const [tenantId, setTenantId] = useState("");
  const [fixingKeys, setFixingKeys] = useState(false);
  const [syncingSlugs, setSyncingSlugs] = useState(false);
  const navigate = useNavigate();

  const createJob = async (type: string, label: string, setLoading: (v: boolean) => void) => {
    if (!tenantId) {
      toast.error("Selecteer eerst een tenant");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.from("jobs").insert({
        type,
        state: "ready" as const,
        payload: { tenantId },
        tenant_id: tenantId,
      });
      if (error) throw error;
      toast.success(`${label} job aangemaakt`, {
        action: { label: "Bekijk Jobs", onClick: () => navigate("/jobs") },
      });
    } catch (e: any) {
      toast.error(`Fout bij aanmaken job: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1>WooCommerce</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Beheer de synchronisatie met je WooCommerce webshop.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Sync Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-success" />
                <span className="text-2xl font-semibold">Connected</span>
              </div>
            </CardContent>
          </Card>

          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Last Sync</CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-semibold">—</span>
              <p className="text-xs text-muted-foreground mt-1">Geen recente sync</p>
            </CardContent>
          </Card>

          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pending Syncs</CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-semibold">0</span>
              <p className="text-xs text-muted-foreground mt-1">Producten in wachtrij</p>
            </CardContent>
          </Card>
        </div>

        <Card className="card-elevated">
          <CardHeader>
            <CardTitle className="text-base">Acties</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <TenantSelector value={tenantId} onChange={setTenantId} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" size="sm">
                <RefreshCw className="mr-2 h-4 w-4" />
                Full Sync
              </Button>
              <Button variant="outline" size="sm">
                <Send className="mr-2 h-4 w-4" />
                Sync Missing Products
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!tenantId || fixingKeys}
                onClick={() => createJob("FIX_URL_KEYS", "Fix URL Keys", setFixingKeys)}
              >
                <Link2 className="mr-2 h-4 w-4" />
                {fixingKeys ? "Bezig..." : "Fix URL Keys"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!tenantId || syncingSlugs}
                onClick={() => createJob("SYNC_WOO_SLUGS", "Sync Slugs", setSyncingSlugs)}
              >
                <Globe className="mr-2 h-4 w-4" />
                {syncingSlugs ? "Bezig..." : "Sync alle Slugs"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="rounded-xl border border-border bg-muted/30 p-8 text-center">
          <Send className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">WooCommerce sync details</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Gedetailleerde sync historie en product-level status worden in V2 toegevoegd.
          </p>
        </div>
      </div>
    </Layout>
  );
};

export default ChannelWooCommerce;
