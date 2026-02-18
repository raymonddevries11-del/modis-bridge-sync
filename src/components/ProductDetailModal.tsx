import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Save, Image as ImageIcon, RefreshCw, AlertCircle, Package, Sparkles } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AiContentTab } from "@/components/AiContentTab";

interface VariantStockCardProps {
  variant: any;
  tenantId: string;
  productSku: string;
}

const VariantStockCard = ({ variant, tenantId, productSku }: VariantStockCardProps) => {
  const queryClient = useQueryClient();
  const currentStock = variant.stock_totals?.qty ?? 0;
  const [stockValue, setStockValue] = useState<string>(currentStock.toString());
  const [isEditing, setIsEditing] = useState(false);

  const updateStockMutation = useMutation({
    mutationFn: async (newQty: number) => {
      // Update stock_totals
      const { error: stockError } = await supabase
        .from("stock_totals")
        .upsert({
          variant_id: variant.id,
          qty: newQty,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'variant_id' });

      if (stockError) throw stockError;

      // Create SYNC_TO_WOO job for this variant
      const { error: jobError } = await supabase
        .from("jobs")
        .insert({
          type: "SYNC_TO_WOO",
          state: "ready",
          tenant_id: tenantId,
          payload: { variantIds: [variant.id] },
        });

      if (jobError) throw jobError;
    },
    onSuccess: () => {
      toast.success(`Voorraad bijgewerkt naar ${stockValue} - sync naar WooCommerce gepland`);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setIsEditing(false);
    },
    onError: (error: any) => {
      toast.error(`Voorraad update mislukt: ${error.message}`);
    },
  });

  const handleSaveStock = () => {
    const newQty = parseInt(stockValue, 10);
    if (isNaN(newQty) || newQty < 0) {
      toast.error("Voer een geldig aantal in");
      return;
    }
    if (newQty === currentStock) {
      setIsEditing(false);
      return;
    }
    updateStockMutation.mutate(newQty);
  };

  const handleCancel = () => {
    setStockValue(currentStock.toString());
    setIsEditing(false);
  };

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span>Maat: {variant.size_label} {variant.maat_web && variant.maat_web !== variant.size_label && `(Web: ${variant.maat_web})`}</span>
          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <Input
                  type="number"
                  min="0"
                  value={stockValue}
                  onChange={(e) => setStockValue(e.target.value)}
                  className="w-20 h-8 text-center"
                  autoFocus
                />
                <Button 
                  size="sm" 
                  onClick={handleSaveStock}
                  disabled={updateStockMutation.isPending}
                >
                  {updateStockMutation.isPending ? "..." : "Opslaan"}
                </Button>
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={handleCancel}
                  disabled={updateStockMutation.isPending}
                >
                  Annuleer
                </Button>
              </>
            ) : (
              <Badge 
                variant={currentStock > 0 ? "default" : "destructive"}
                className="cursor-pointer hover:opacity-80"
                onClick={() => setIsEditing(true)}
              >
                <Package className="h-3 w-3 mr-1" />
                Voorraad: {currentStock}
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Woo SKU:</span>
          <p className="font-mono text-xs">{productSku && variant.maat_id ? `${productSku}-${variant.maat_id.includes('-') ? variant.maat_id.split('-').pop() : variant.maat_id}` : "N/A"}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Maat ID:</span>
          <p className="font-mono text-xs">{variant.maat_id || "N/A"}</p>
        </div>
        <div>
          <span className="text-muted-foreground">EAN:</span>
          <p className="font-mono">{variant.ean || "N/A"}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Status:</span>
          <Badge variant={variant.active ? "default" : "secondary"}>
            {variant.active ? "Actief" : "Inactief"}
          </Badge>
        </div>
        <div>
          <span className="text-muted-foreground">Backorder:</span>
          <Badge variant={variant.allow_backorder ? "default" : "outline"}>
            {variant.allow_backorder ? "Ja" : "Nee"}
          </Badge>
        </div>
        <div>
          <span className="text-muted-foreground">Updated:</span>
          <p>{new Date(variant.updated_at).toLocaleDateString()}</p>
        </div>
      </CardContent>
    </Card>
  );
};

interface ProductDetailModalProps {
  product: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const wooCommerceFieldMapping = [
  { label: "Product Title", dbField: "title", wooField: "name" },
  { label: "SKU", dbField: "sku", wooField: "sku" },
  { label: "Price", dbField: "product_prices.regular", wooField: "regular_price" },
  { label: "List Price", dbField: "product_prices.list", wooField: "sale_price" },
  { label: "Tax Code", dbField: "tax_code", wooField: "tax_class" },
  { label: "URL Key", dbField: "url_key", wooField: "slug" },
];

export const ProductDetailModal = ({ product, open, onOpenChange }: ProductDetailModalProps) => {
  const queryClient = useQueryClient();
  const [editedProduct, setEditedProduct] = useState(product);

  const { data: compareData, isLoading: isComparing, refetch: refetchCompare } = useQuery({
    queryKey: ["product-compare", product.id],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("compare-product", {
        body: { productId: product.id, tenantId: product.tenant_id },
      });
      if (error) throw error;
      return data;
    },
    enabled: false, // Only fetch when user clicks compare
  });

  const updateProductMutation = useMutation({
    mutationFn: async (updatedData: any) => {
      const { error: productError } = await supabase
        .from("products")
        .update({
          title: updatedData.title,
          sku: updatedData.sku,
          tax_code: updatedData.tax_code,
          url_key: updatedData.url_key,
        })
        .eq("id", product.id);

      if (productError) throw productError;

      if (updatedData.product_prices) {
        const { error: priceError } = await supabase
          .from("product_prices")
          .update({
            regular: updatedData.product_prices.regular,
            list: updatedData.product_prices.list,
          })
          .eq("product_id", product.id);

        if (priceError) throw priceError;
      }
    },
    onSuccess: () => {
      toast.success("Product bijgewerkt");
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: any) => {
      toast.error(`Update mislukt: ${error.message}`);
    },
  });

  const handleSave = () => {
    updateProductMutation.mutate(editedProduct);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Product Details: {product.title}</span>
            <Button onClick={handleSave} disabled={updateProductMutation.isPending}>
              <Save className="h-4 w-4 mr-2" />
              Opslaan
            </Button>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="details" className="w-full">
          <TabsList className="flex w-full overflow-x-auto">
            <TabsTrigger value="details" className="flex-shrink-0">Details</TabsTrigger>
            <TabsTrigger value="content" className="flex-shrink-0">SEO</TabsTrigger>
            <TabsTrigger value="ai-content" className="flex-shrink-0 flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              AI
            </TabsTrigger>
            <TabsTrigger value="variants" className="flex-shrink-0">Varianten ({product.variants?.length || 0})</TabsTrigger>
            <TabsTrigger value="images" className="flex-shrink-0">Afb. ({product.images?.length || 0})</TabsTrigger>
            <TabsTrigger value="compare" className="flex-shrink-0 flex items-center gap-1">
              Vergelijk
              {compareData?.differences?.fields && Object.keys(compareData.differences.fields).length > 0 && (
                <Badge variant="destructive" className="ml-1 h-5 w-5 p-0 flex items-center justify-center text-xs">{Object.keys(compareData.differences.fields).length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="woo-mapping" className="flex-shrink-0">Mapping</TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="title">Product Title</Label>
                <Input
                  id="title"
                  value={editedProduct.title}
                  onChange={(e) => setEditedProduct({ ...editedProduct, title: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="sku">SKU</Label>
                <Input
                  id="sku"
                  value={editedProduct.sku}
                  onChange={(e) => setEditedProduct({ ...editedProduct, sku: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="brand">Brand</Label>
                <Input id="brand" value={product.brands?.name || "N/A"} disabled />
              </div>

              <div className="space-y-2">
                <Label htmlFor="supplier">Supplier</Label>
                <Input id="supplier" value={product.suppliers?.name || "N/A"} disabled />
              </div>

              {product.product_prices && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="regular-price">Regular Price (€)</Label>
                    <Input
                      id="regular-price"
                      type="number"
                      step="0.01"
                      value={editedProduct.product_prices?.regular || ""}
                      onChange={(e) =>
                        setEditedProduct({
                          ...editedProduct,
                          product_prices: { ...editedProduct.product_prices, regular: e.target.value },
                        })
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="list-price">List Price (€)</Label>
                    <Input
                      id="list-price"
                      type="number"
                      step="0.01"
                      value={editedProduct.product_prices?.list || ""}
                      onChange={(e) =>
                        setEditedProduct({
                          ...editedProduct,
                          product_prices: { ...editedProduct.product_prices, list: e.target.value },
                        })
                      }
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="cost-price">Cost Price (€)</Label>
                <Input
                  id="cost-price"
                  type="number"
                  step="0.01"
                  value={product.cost_price || ""}
                  disabled
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="discount">Discount (%)</Label>
                <Input
                  id="discount"
                  type="number"
                  step="0.01"
                  value={product.discount_percentage || ""}
                  disabled
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tax-code">Tax Code</Label>
                <Input
                  id="tax-code"
                  value={editedProduct.tax_code || ""}
                  onChange={(e) => setEditedProduct({ ...editedProduct, tax_code: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="url-key">URL Key</Label>
                <Input
                  id="url-key"
                  value={editedProduct.url_key || ""}
                  onChange={(e) => setEditedProduct({ ...editedProduct, url_key: e.target.value })}
                />
              </div>
            </div>

            {product.color && (
              <div className="space-y-2">
                <Label>Kleur Informatie</Label>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Webshop:</span>
                    <p className="font-medium">{product.color.webshop || "N/A"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Artikel:</span>
                    <p className="font-medium">{product.color.article || "N/A"}</p>
                  </div>
                </div>
              </div>
            )}

            {product.categories && product.categories.length > 0 && (
              <div className="space-y-2 pt-4 border-t">
                <Label>Webshop Categorieën</Label>
                <div className="flex flex-wrap gap-2">
                  {product.categories.map((cat: any, idx: number) => (
                    <Badge key={idx} variant="secondary">
                      {cat.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {product.attributes && Object.keys(product.attributes).length > 0 && (
              <div className="space-y-3 pt-4 border-t">
                <Label className="text-base">Product Eigenschappen</Label>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {Object.entries(product.attributes).map(([key, value]: [string, any]) => (
                    <div key={key}>
                      <span className="text-muted-foreground">{key}:</span>
                      <p className="font-medium">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(product.outlet_sale || product.is_promotion || product.plan_period) && (
              <div className="space-y-2 pt-4 border-t">
                <Label>Product Status</Label>
                <div className="flex flex-wrap gap-2">
                  {product.outlet_sale && <Badge variant="destructive">Outlet/Sale</Badge>}
                  {product.is_promotion && <Badge variant="default">In Promotie</Badge>}
                  {product.plan_period && <Badge variant="outline">Seizoen: {product.plan_period}</Badge>}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="content" className="space-y-4">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="internal-desc">Interne Omschrijving</Label>
                <Input
                  id="internal-desc"
                  value={product.internal_description || ""}
                  disabled
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="webshop-text">Product Beschrijving (NL)</Label>
                <Textarea
                  id="webshop-text"
                  value={product.webshop_text || ""}
                  disabled
                  rows={5}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="webshop-text-en">Product Beschrijving (EN)</Label>
                <Textarea
                  id="webshop-text-en"
                  value={product.webshop_text_en || ""}
                  disabled
                  rows={5}
                />
              </div>
            </div>

            <div className="pt-4 border-t space-y-4">
              <Label className="text-base">SEO Informatie</Label>
              
              <div className="space-y-2">
                <Label htmlFor="meta-title">Meta Title</Label>
                <Input
                  id="meta-title"
                  value={product.meta_title || ""}
                  disabled
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="meta-keywords">Meta Keywords</Label>
                <Input
                  id="meta-keywords"
                  value={product.meta_keywords || ""}
                  disabled
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="meta-description">Meta Description</Label>
                <Textarea
                  id="meta-description"
                  value={product.meta_description || ""}
                  disabled
                  rows={3}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="ai-content" className="space-y-4">
            <AiContentTab product={product} />
          </TabsContent>

          <TabsContent value="variants" className="space-y-4">
            {product.variants && product.variants.length > 0 ? (
              <div className="grid gap-3">
                {product.variants.map((variant: any) => (
                  <VariantStockCard 
                    key={variant.id} 
                    variant={variant} 
                    tenantId={product.tenant_id}
                    productSku={product.sku}
                  />
                ))}
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8">Geen variants beschikbaar</p>
            )}
          </TabsContent>

          <TabsContent value="images" className="space-y-4">
            {product.images && product.images.length > 0 ? (
              <div className="grid grid-cols-3 gap-4">
                {product.images.map((imageUrl: string, index: number) => (
                  <Card key={index}>
                    <CardContent className="p-4">
                      <img
                        src={imageUrl}
                        alt={`Product afbeelding ${index + 1}`}
                        className="w-full h-48 object-cover rounded-md"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "/placeholder.svg";
                        }}
                      />
                      <p className="text-xs text-muted-foreground mt-2 truncate">{imageUrl}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <ImageIcon className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>Geen afbeeldingen beschikbaar</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="compare" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Database vs WooCommerce</CardTitle>
                  <Button
                    onClick={() => refetchCompare()}
                    disabled={isComparing}
                    size="sm"
                    variant="outline"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${isComparing ? "animate-spin" : ""}`} />
                    {isComparing ? "Vergelijken..." : "Vergelijk"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {!compareData && !isComparing && (
                  <div className="text-center py-8 text-muted-foreground">
                    <AlertCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                    <p>Klik op "Vergelijk" om verschillen te zien</p>
                  </div>
                )}

                {isComparing && (
                  <div className="text-center py-8 text-muted-foreground">
                    <RefreshCw className="h-12 w-12 mx-auto mb-2 animate-spin" />
                    <p>Producten vergelijken...</p>
                  </div>
                )}

                {compareData && !isComparing && (
                  <div className="space-y-4">
                    {!compareData.differences?.exists && (
                      <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>
                          Product niet gevonden in WooCommerce. Dit product moet nog worden gesynchroniseerd.
                        </AlertDescription>
                      </Alert>
                    )}

                    {compareData.differences?.exists && Object.keys(compareData.differences.fields).length === 0 && (
                      <Alert>
                        <AlertDescription className="text-green-600">
                          ✓ Alle velden zijn synchroon tussen database en WooCommerce
                        </AlertDescription>
                      </Alert>
                    )}

                    {compareData.differences?.exists && Object.keys(compareData.differences.fields).length > 0 && (
                      <>
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription>
                            {Object.keys(compareData.differences.fields).length} verschil(len) gevonden
                          </AlertDescription>
                        </Alert>

                        <div className="space-y-3">
                          {Object.entries(compareData.differences.fields).map(([field, values]: [string, any]) => (
                            <Card key={field} className="border-l-4 border-l-orange-500">
                              <CardContent className="pt-4">
                                <div className="space-y-2">
                                  <p className="font-semibold text-sm">{field}</p>
                                  <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div className="space-y-1">
                                      <p className="text-muted-foreground text-xs">Database:</p>
                                      <Badge variant="outline" className="font-mono">
                                        {values.database || "N/A"}
                                      </Badge>
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-muted-foreground text-xs">WooCommerce:</p>
                                      <Badge variant="secondary" className="font-mono">
                                        {values.woocommerce || "N/A"}
                                      </Badge>
                                    </div>
                                  </div>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="woo-mapping" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">WooCommerce Veld Mapping</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {wooCommerceFieldMapping.map((mapping) => (
                    <div key={mapping.dbField} className="grid grid-cols-3 gap-4 items-center py-2 border-b">
                      <div>
                        <p className="font-medium text-sm">{mapping.label}</p>
                      </div>
                      <div>
                        <Badge variant="outline" className="font-mono text-xs">
                          {mapping.dbField}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-sm">→</span>
                        <Badge variant="secondary" className="font-mono text-xs">
                          {mapping.wooField}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-4">
                  Deze mapping toont hoe database velden worden gekoppeld aan WooCommerce product velden tijdens synchronisatie.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
