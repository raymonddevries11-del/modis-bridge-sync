import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const Orders = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const queryClient = useQueryClient();

  const { data: orders, isLoading } = useQuery({
    queryKey: ["orders", searchTerm],
    queryFn: async () => {
      let query = supabase
        .from("orders")
        .select(`
          *,
          order_lines(*)
        `)
        .order("created_at", { ascending: false });

      if (searchTerm) {
        query = query.or(`order_number.ilike.%${searchTerm}%,status.ilike.%${searchTerm}%`);
      }

      const { data } = await query.limit(50);
      return data || [];
    },
  });

  const importOrders = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('import-woocommerce-orders');
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Orders geïmporteerd: ${data.imported} nieuwe, ${data.skipped} overgeslagen`);
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (error: Error) => {
      toast.error(`Import gefaald: ${error.message}`);
    },
  });

  const exportOrder = useMutation({
    mutationFn: async (orderNumber: string) => {
      const { data, error } = await supabase.functions.invoke('export-orders', {
        body: { orderNumber }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Order ${data.orderNumber} geëxporteerd naar XML`);
    },
    onError: (error: Error) => {
      toast.error(`Export gefaald: ${error.message}`);
    },
  });

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "completed":
      case "paid":
        return "bg-success/10 text-success border-success/20";
      case "processing":
        return "bg-primary/10 text-primary border-primary/20";
      case "pending":
        return "bg-warning/10 text-warning border-warning/20";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
          <p className="text-muted-foreground">
            View and manage orders from WooCommerce
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by order number or status..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button 
            onClick={() => importOrders.mutate()}
            disabled={importOrders.isPending}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${importOrders.isPending ? 'animate-spin' : ''}`} />
            Importeer Orders
          </Button>
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading orders...</p>
          </div>
        ) : orders && orders.length > 0 ? (
          <div className="space-y-4">
            {orders.map((order: any) => (
              <Card key={order.order_number}>
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="grid md:grid-cols-4 gap-4 flex-1">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Order Number</p>
                        <p className="font-semibold">{order.order_number}</p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Status</p>
                        <Badge className={getStatusColor(order.status)} variant="outline">
                          {order.status}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Total</p>
                        <p className="font-semibold">
                          €{Number(order.totals?.total || 0).toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Created</p>
                        <p className="text-sm">{new Date(order.created_at).toLocaleString()}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => exportOrder.mutate(order.order_number)}
                      disabled={exportOrder.isPending}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Export XML
                    </Button>
                  </div>
                  {order.order_lines && order.order_lines.length > 0 && (
                    <div className="mt-4 pt-4 border-t">
                      <p className="text-sm font-medium text-muted-foreground mb-2">
                        Items ({order.order_lines.length})
                      </p>
                      <div className="space-y-2">
                        {order.order_lines.slice(0, 3).map((line: any) => (
                          <div key={line.id} className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">
                              {line.qty}x {line.name}
                            </span>
                            <span className="font-medium">€{Number(line.unit_price).toFixed(2)}</span>
                          </div>
                        ))}
                        {order.order_lines.length > 3 && (
                          <p className="text-xs text-muted-foreground">
                            + {order.order_lines.length - 3} more items
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">
                {searchTerm ? "No orders found matching your search" : "No orders found"}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
};

export default Orders;
