import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Send, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";

const ChannelWooCommerce = () => {
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
          <CardContent className="flex flex-wrap gap-3">
            <Button variant="outline" size="sm">
              <RefreshCw className="mr-2 h-4 w-4" />
              Full Sync
            </Button>
            <Button variant="outline" size="sm">
              <Send className="mr-2 h-4 w-4" />
              Sync Missing Products
            </Button>
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
