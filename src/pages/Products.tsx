import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const Products = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const queryClient = useQueryClient();

  const { data: products, isLoading } = useQuery({
    queryKey: ["products", searchTerm],
    queryFn: async () => {
      let query = supabase
        .from("products")
        .select(`
          *,
          brands(name),
          suppliers(name),
          product_prices(*),
          variants(*)
        `)
        .order("created_at", { ascending: false });

      if (searchTerm) {
        query = query.or(`sku.ilike.%${searchTerm}%,title.ilike.%${searchTerm}%`);
      }

      const { data } = await query.limit(50);
      return data || [];
    },
  });

  const syncToWooCommerce = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("woocommerce-sync");
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`WooCommerce sync started: ${data.processed} jobs queued`);
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error: any) => {
      toast.error(`Sync failed: ${error.message}`);
    },
  });

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Products</h1>
          <p className="text-muted-foreground">
            Browse and manage your product catalog
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by SKU or title..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            onClick={() => syncToWooCommerce.mutate()}
            disabled={syncToWooCommerce.isPending}
            variant="outline"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncToWooCommerce.isPending ? "animate-spin" : ""}`} />
            Sync to WooCommerce
          </Button>
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading products...</p>
          </div>
        ) : products && products.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {products.map((product: any) => (
              <Card key={product.id} className="hover:shadow-md transition-shadow">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base truncate">{product.title}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">SKU: {product.sku}</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Brand:</span>
                    <Badge variant="outline">{product.brands?.name || "N/A"}</Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Supplier:</span>
                    <Badge variant="outline">{product.suppliers?.name || "N/A"}</Badge>
                  </div>
                  {product.product_prices && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Price:</span>
                      <span className="font-semibold">
                        €{Number(product.product_prices.regular || 0).toFixed(2)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Variants:</span>
                    <Badge>{product.variants?.length || 0}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">
                {searchTerm ? "No products found matching your search" : "No products found"}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
};

export default Products;
