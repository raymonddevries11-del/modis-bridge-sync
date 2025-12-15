import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { TenantSelector } from "@/components/TenantSelector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProductDetailModal } from "@/components/ProductDetailModal";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useState, useEffect, useRef } from "react";
import { Search, RefreshCw, Calendar, Image, Upload, FileSpreadsheet, AlertTriangle, Package } from "lucide-react";
import { toast } from "sonner";

const Products = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const stockInputRef = useRef<HTMLInputElement>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [stockFilter, setStockFilter] = useState<string>("all");
  const [selectedTenant, setSelectedTenant] = useState<string>("");
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const queryClient = useQueryClient();

  // Auto-select first active tenant
  const { data: tenants } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("*")
        .eq("active", true)
        .order("name");
      return data || [];
    },
  });

  useEffect(() => {
    if (tenants && tenants.length > 0 && !selectedTenant) {
      setSelectedTenant(tenants[0].id);
    }
  }, [tenants, selectedTenant]);

  const { data: brands } = useQuery({
    queryKey: ["brands"],
    queryFn: async () => {
      const { data } = await supabase
        .from("brands")
        .select("id, name")
        .order("name");
      return data || [];
    },
  });

  const { data: suppliers } = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const { data } = await supabase
        .from("suppliers")
        .select("id, name")
        .order("name");
      return data || [];
    },
  });

  const { data: products, isLoading } = useQuery({
    queryKey: ["products", searchTerm, brandFilter, supplierFilter, stockFilter, selectedTenant],
    queryFn: async () => {
      if (!selectedTenant) return [];
      
      let query = supabase
        .from("products")
        .select(`
          *,
          brands(id, name),
          suppliers(id, name),
          product_prices(*),
          variants(*, stock_totals(*))
        `)
        .eq("tenant_id", selectedTenant)
        .order("updated_at", { ascending: false });

      if (searchTerm) {
        query = query.or(`sku.ilike.%${searchTerm}%,title.ilike.%${searchTerm}%`);
      }

      if (brandFilter !== "all") {
        query = query.eq("brand_id", brandFilter);
      }

      if (supplierFilter !== "all") {
        query = query.eq("supplier_id", supplierFilter);
      }

      const { data } = await query.limit(500);
      
      // Client-side filter for stock
      if (stockFilter === "in_stock" && data) {
        return data.filter((product: any) => 
          product.variants?.some((variant: any) => 
            variant.stock_totals?.qty > 0
          )
        );
      }
      if (stockFilter === "out_of_stock" && data) {
        return data.filter((product: any) => 
          !product.variants?.some((variant: any) => 
            variant.stock_totals?.qty > 0
          )
        );
      }
      
      return data || [];
    },
  });

  const updatePrices = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("update-woo-prices");
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Prijzen bijgewerkt: ${data.updated} producten. ${data.notFound} niet gevonden in WooCommerce.`);
    },
    onError: (error: any) => {
      toast.error(`Update mislukt: ${error.message}`);
    },
  });

  const syncToWooCommerce = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("trigger-woocommerce-sync");
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`WooCommerce sync gestart: ${data.productsQueued} producten in wachtrij`);
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error: any) => {
      toast.error(`Sync mislukt: ${error.message}`);
    },
  });

  const updateMaatIds = useMutation({
    mutationFn: async ({ content, isXml }: { content: string; isXml: boolean }) => {
      const { data, error } = await supabase.functions.invoke("update-maat-ids", {
        body: isXml
          ? { fileName: "manual-upload.xml", xmlContent: content, tenantId: selectedTenant }
          : { csvContent: content, tenantId: selectedTenant },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Maat ID's bijgewerkt: ${data.results.updated} varianten geüpdatet`);
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: any) => {
      toast.error(`Update mislukt: ${error.message}`);
    },
  });

  const updateWooSkus = useMutation({
    mutationFn: async (csvContent: string) => {
      const { data, error } = await supabase.functions.invoke("update-woo-variation-skus", {
        body: { csvContent, tenantId: selectedTenant },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`WooCommerce SKU's bijgewerkt: ${data.updated} variaties, ${data.errors} fouten`);
    },
    onError: (error: any) => {
      toast.error(`Update mislukt: ${error.message}`);
    },
  });

  const importStock = useMutation({
    mutationFn: async (xmlContent: string) => {
      const { data, error } = await supabase.functions.invoke("process-stock-full", {
        body: { 
          fileName: "manual-stock-import.xml", 
          xmlContent, 
          tenantId: selectedTenant 
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Voorraad geïmporteerd: ${data.results.variantsUpdated} varianten bijgewerkt, ${data.results.changedVariants} gewijzigd`);
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: any) => {
      toast.error(`Import mislukt: ${error.message}`);
    },
  });

  const [resetJobId, setResetJobId] = useState<string | null>(null);
  const [resetProgress, setResetProgress] = useState<{ current: number; total: number; updated: number } | null>(null);

  const resetWooStock = useMutation({
    mutationFn: async (jobId?: string) => {
      const { data, error } = await supabase.functions.invoke("reset-woo-stock", {
        body: { tenantId: selectedTenant, jobId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      if (data.complete) {
        toast.success(`WooCommerce voorraad reset voltooid: ${data.progress.totalVariationsUpdated} variaties op 0 gezet`);
        setResetJobId(null);
        setResetProgress(null);
        queryClient.invalidateQueries({ queryKey: ["products"] });
      } else {
        // Continue with next batch
        setResetJobId(data.jobId);
        setResetProgress({
          current: data.progress.currentPage - 1,
          total: data.progress.totalPages,
          updated: data.progress.totalVariationsUpdated,
        });
        toast.info(`Voortgang: pagina ${data.progress.currentPage - 1}/${data.progress.totalPages} (${data.progress.totalVariationsUpdated} variaties)`);
        
        // Auto-continue after short delay
        setTimeout(() => {
          resetWooStock.mutate(data.jobId);
        }, 1000);
      }
    },
    onError: (error: any) => {
      toast.error(`Reset mislukt: ${error.message}`);
      setResetJobId(null);
      setResetProgress(null);
    },
  });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    const isXml = fileName.endsWith('.xml');
    const isCsv = fileName.endsWith('.csv');

    if (!isXml && !isCsv) {
      toast.error('Alleen XML of CSV bestanden zijn toegestaan');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        toast.info('Maat ID update gestart...');
        updateMaatIds.mutate({ content, isXml });
      }
    };
    reader.onerror = () => {
      toast.error('Kon bestand niet lezen');
    };
    reader.readAsText(file);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast.error('Alleen CSV bestanden zijn toegestaan');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        toast.info('WooCommerce SKU update gestart... Dit kan enkele minuten duren.');
        updateWooSkus.mutate(content);
      }
    };
    reader.onerror = () => {
      toast.error('Kon bestand niet lezen');
    };
    reader.readAsText(file);
    
    if (csvInputRef.current) {
      csvInputRef.current.value = '';
    }
  };

  const handleStockUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.xml')) {
      toast.error('Alleen XML bestanden zijn toegestaan');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        toast.info('Voorraad import gestart... Dit kan even duren bij grote bestanden.');
        importStock.mutate(content);
      }
    };
    reader.onerror = () => {
      toast.error('Kon bestand niet lezen');
    };
    reader.readAsText(file);
    
    if (stockInputRef.current) {
      stockInputRef.current.value = '';
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Products</h1>
            <p className="text-muted-foreground">
              Browse and manage your product catalog {products && `(${products.length} items)`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <TenantSelector 
            value={selectedTenant} 
            onChange={setSelectedTenant} 
          />
          
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by SKU or title..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>

          <Select value={brandFilter} onValueChange={setBrandFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by brand" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Brands</SelectItem>
              {brands?.map((brand) => (
                <SelectItem key={brand.id} value={brand.id}>
                  {brand.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={supplierFilter} onValueChange={setSupplierFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by supplier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Suppliers</SelectItem>
              {suppliers?.map((supplier) => (
                <SelectItem key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={stockFilter} onValueChange={setStockFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by stock" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle producten</SelectItem>
              <SelectItem value="in_stock">Op voorraad</SelectItem>
              <SelectItem value="out_of_stock">Niet op voorraad</SelectItem>
            </SelectContent>
          </Select>

          <Button
            onClick={() => updatePrices.mutate()}
            disabled={updatePrices.isPending}
            variant="default"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${updatePrices.isPending ? "animate-spin" : ""}`} />
            Update Prijzen
          </Button>

          <Button
            onClick={() => syncToWooCommerce.mutate()}
            disabled={syncToWooCommerce.isPending}
            variant="outline"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncToWooCommerce.isPending ? "animate-spin" : ""}`} />
            Sync Nieuwe Producten
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.csv"
            onChange={handleFileUpload}
            className="hidden"
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={updateMaatIds.isPending || !selectedTenant}
            variant="secondary"
          >
            <Upload className={`h-4 w-4 mr-2 ${updateMaatIds.isPending ? "animate-spin" : ""}`} />
            Update Maat IDs
          </Button>

          <input
            ref={csvInputRef}
            type="file"
            accept=".csv"
            onChange={handleCsvUpload}
            className="hidden"
          />
          <Button
            onClick={() => csvInputRef.current?.click()}
            disabled={updateWooSkus.isPending || !selectedTenant}
            variant="secondary"
          >
            <FileSpreadsheet className={`h-4 w-4 mr-2 ${updateWooSkus.isPending ? "animate-spin" : ""}`} />
            Update WooCommerce SKUs
          </Button>

          <input
            ref={stockInputRef}
            type="file"
            accept=".xml"
            onChange={handleStockUpload}
            className="hidden"
          />
          <Button
            onClick={() => stockInputRef.current?.click()}
            disabled={importStock.isPending || !selectedTenant}
            variant="default"
          >
            <Package className={`h-4 w-4 mr-2 ${importStock.isPending ? "animate-spin" : ""}`} />
            Import Voorraad XML
          </Button>

          {resetProgress ? (
            <div className="flex items-center gap-3 bg-muted rounded-md px-4 py-2 min-w-[280px]">
              <RefreshCw className="h-4 w-4 animate-spin text-destructive" />
              <div className="flex-1">
                <div className="flex justify-between text-sm mb-1">
                  <span>Reset bezig...</span>
                  <span className="font-medium">{resetProgress.current}/{resetProgress.total}</span>
                </div>
                <Progress value={(resetProgress.current / resetProgress.total) * 100} className="h-2" />
                <p className="text-xs text-muted-foreground mt-1">{resetProgress.updated} variaties op 0 gezet</p>
              </div>
            </div>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  disabled={resetWooStock.isPending || !selectedTenant}
                  variant="destructive"
                >
                  <AlertTriangle className={`h-4 w-4 mr-2 ${resetWooStock.isPending ? "animate-spin" : ""}`} />
                  Reset WooCommerce Voorraad
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Weet je het zeker?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Dit zet de voorraad van ALLE productvariaties in WooCommerce op 0. 
                    Dit kan niet ongedaan worden gemaakt. Dit proces kan enkele minuten duren.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuleren</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => resetWooStock.mutate(undefined)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Ja, reset voorraad
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading products...</p>
          </div>
        ) : products && products.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {products.map((product: any) => (
              <Card 
                key={product.id} 
                className="hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => {
                  setSelectedProduct(product);
                  setIsModalOpen(true);
                }}
              >
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
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Afbeeldingen:</span>
                    <div className="flex items-center gap-2">
                      {product.images && product.images.length > 0 ? (
                        <>
                          <Image className="h-4 w-4 text-green-600" />
                          <Badge variant="default" className="bg-green-600">
                            {product.images.length}
                          </Badge>
                        </>
                      ) : (
                        <Badge variant="secondary" className="text-muted-foreground">
                          Geen
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t">
                    <Calendar className="h-3 w-3" />
                    <span>Updated: {new Date(product.updated_at).toLocaleDateString()}</span>
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

        {selectedProduct && (
          <ProductDetailModal
            product={selectedProduct}
            open={isModalOpen}
            onOpenChange={setIsModalOpen}
          />
        )}
      </div>
    </Layout>
  );
};

export default Products;
