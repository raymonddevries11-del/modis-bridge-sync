import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Save, Image as ImageIcon } from "lucide-react";

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
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="variants">Variants ({product.variants?.length || 0})</TabsTrigger>
            <TabsTrigger value="images">Afbeeldingen ({product.images?.length || 0})</TabsTrigger>
            <TabsTrigger value="woo-mapping">WooCommerce Mapping</TabsTrigger>
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
                    <span className="text-muted-foreground">Kleur:</span>
                    <p className="font-medium">{product.color.label || "N/A"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Filter:</span>
                    <p className="font-medium">{product.color.filter || "N/A"}</p>
                  </div>
                </div>
              </div>
            )}

            {product.attributes && (
              <div className="space-y-3 pt-4 border-t">
                <Label className="text-base">Product Eigenschappen</Label>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {product.attributes.gender && (
                    <div>
                      <span className="text-muted-foreground">Gender:</span>
                      <p className="font-medium">{product.attributes.gender}</p>
                    </div>
                  )}
                  {product.attributes.upperMaterial && (
                    <div>
                      <span className="text-muted-foreground">Bovenmateriaal:</span>
                      <p className="font-medium">{product.attributes.upperMaterial}</p>
                    </div>
                  )}
                  {product.attributes.lining && (
                    <div>
                      <span className="text-muted-foreground">Voering:</span>
                      <p className="font-medium">{product.attributes.lining}</p>
                    </div>
                  )}
                  {product.attributes.insole && (
                    <div>
                      <span className="text-muted-foreground">Binnenzool:</span>
                      <p className="font-medium">{product.attributes.insole}</p>
                    </div>
                  )}
                  {product.attributes.sole && (
                    <div>
                      <span className="text-muted-foreground">Zool:</span>
                      <p className="font-medium">{product.attributes.sole}</p>
                    </div>
                  )}
                  {product.attributes.type && (
                    <div>
                      <span className="text-muted-foreground">Type:</span>
                      <p className="font-medium">{product.attributes.type}</p>
                    </div>
                  )}
                  {product.attributes.heelHeight && (
                    <div>
                      <span className="text-muted-foreground">Hakhoogte:</span>
                      <p className="font-medium">{product.attributes.heelHeight}</p>
                    </div>
                  )}
                  {product.attributes.closure && (
                    <div>
                      <span className="text-muted-foreground">Sluiting:</span>
                      <p className="font-medium">{product.attributes.closure}</p>
                    </div>
                  )}
                  {product.attributes.supplierDescription && (
                    <div>
                      <span className="text-muted-foreground">Leveranciers omschrijving:</span>
                      <p className="font-medium font-mono text-xs">{product.attributes.supplierDescription}</p>
                    </div>
                  )}
                  {product.attributes.supplierTitle && (
                    <div>
                      <span className="text-muted-foreground">Leveranciers titel:</span>
                      <p className="font-medium">{product.attributes.supplierTitle}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="variants" className="space-y-4">
            {product.variants && product.variants.length > 0 ? (
              <div className="grid gap-3">
                {product.variants.map((variant: any) => (
                  <Card key={variant.id}>
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm font-medium">
                        Maat: {variant.size_label} (ID: {variant.maat_id})
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-3 gap-4 text-sm">
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
                        <span className="text-muted-foreground">Updated:</span>
                        <p>{new Date(variant.updated_at).toLocaleDateString()}</p>
                      </div>
                    </CardContent>
                  </Card>
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
