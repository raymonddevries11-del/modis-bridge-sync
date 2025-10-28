import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TenantSelector } from "@/components/TenantSelector";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { 
  FileText, 
  Package, 
  Image as ImageIcon, 
  ShoppingCart, 
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Building2
} from "lucide-react";

interface ChangelogEntry {
  id: string;
  tenant_id: string;
  event_type: string;
  description: string;
  metadata: any;
  created_at: string;
  tenants?: {
    name: string;
    slug: string;
  };
}

const Changelog = () => {
  const [selectedTenant, setSelectedTenant] = useState<string>("all");

  const { data: changelog, isLoading } = useQuery({
    queryKey: ["changelog", selectedTenant],
    queryFn: async () => {
      let query = supabase
        .from("changelog")
        .select(`
          *,
          tenants!inner(name, slug)
        `)
        .order("created_at", { ascending: false })
        .limit(100);

      if (selectedTenant && selectedTenant !== "all") {
        query = query.eq("tenant_id", selectedTenant);
      }

      const { data } = await query;
      return (data as ChangelogEntry[]) || [];
    },
  });

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case "PRODUCTS_IMPORTED":
        return <Package className="h-4 w-4 text-blue-600" />;
      case "IMAGES_UPLOADED":
        return <ImageIcon className="h-4 w-4 text-purple-600" />;
      case "ORDERS_IMPORTED":
        return <ShoppingCart className="h-4 w-4 text-green-600" />;
      case "ORDERS_EXPORTED":
        return <FileText className="h-4 w-4 text-orange-600" />;
      case "SYNC_COMPLETED":
        return <RefreshCw className="h-4 w-4 text-teal-600" />;
      case "SYNC_FAILED":
        return <AlertCircle className="h-4 w-4 text-red-600" />;
      default:
        return <CheckCircle2 className="h-4 w-4 text-gray-600" />;
    }
  };

  const getEventColor = (eventType: string) => {
    switch (eventType) {
      case "PRODUCTS_IMPORTED":
        return "default";
      case "IMAGES_UPLOADED":
        return "secondary";
      case "ORDERS_IMPORTED":
      case "SYNC_COMPLETED":
        return "default";
      case "ORDERS_EXPORTED":
        return "outline";
      case "SYNC_FAILED":
        return "destructive";
      default:
        return "outline";
    }
  };

  const groupByDate = (entries: ChangelogEntry[]) => {
    const grouped: { [key: string]: ChangelogEntry[] } = {};
    
    entries.forEach((entry) => {
      const date = new Date(entry.created_at).toLocaleDateString("nl-NL", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      
      if (!grouped[date]) {
        grouped[date] = [];
      }
      grouped[date].push(entry);
    });
    
    return grouped;
  };

  const groupedChangelog = changelog ? groupByDate(changelog) : {};

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
          <p className="text-muted-foreground">
            Overzicht van alle wijzigingen en activiteiten per tenant
          </p>
        </div>

        <div className="flex gap-4">
          <TenantSelector
            value={selectedTenant}
            onChange={setSelectedTenant}
            showAll={true}
          />
        </div>

        {isLoading ? (
          <Card>
            <CardContent className="py-12 text-center">
              <RefreshCw className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-4">Changelog laden...</p>
            </CardContent>
          </Card>
        ) : Object.keys(groupedChangelog).length > 0 ? (
          <div className="space-y-6">
            {Object.entries(groupedChangelog).map(([date, entries]) => (
              <div key={date}>
                <h2 className="text-lg font-semibold mb-3 sticky top-0 bg-background py-2">
                  {date}
                </h2>
                <div className="space-y-2">
                  {entries.map((entry) => (
                    <Card key={entry.id}>
                      <CardContent className="py-4">
                        <div className="flex items-start gap-3">
                          {getEventIcon(entry.event_type)}
                          <div className="flex-1 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              {entry.tenants && (
                                <Badge variant="outline" className="gap-1">
                                  <Building2 className="h-3 w-3" />
                                  {entry.tenants.name}
                                </Badge>
                              )}
                              <Badge variant={getEventColor(entry.event_type)}>
                                {entry.event_type}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {new Date(entry.created_at).toLocaleTimeString("nl-NL", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                            </div>
                            <p className="text-sm">{entry.description}</p>
                            {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                              <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded mt-2">
                                {entry.metadata.productCount && (
                                  <div>Producten: {entry.metadata.productCount}</div>
                                )}
                                {entry.metadata.variantCount && (
                                  <div>Varianten: {entry.metadata.variantCount}</div>
                                )}
                                {entry.metadata.imageCount && (
                                  <div>Afbeeldingen: {entry.metadata.imageCount}</div>
                                )}
                                {entry.metadata.orderCount && (
                                  <div>Orders: {entry.metadata.orderCount}</div>
                                )}
                                {entry.metadata.error && (
                                  <div className="text-destructive">Error: {entry.metadata.error}</div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-sm text-muted-foreground">
                Nog geen changelog entries.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
};

export default Changelog;
