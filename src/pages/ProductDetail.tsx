import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { AiContentTab } from "@/components/AiContentTab";
import { calculateCompleteness, scoreColor, scoreBg } from "@/lib/completeness";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Image as ImageIcon, RefreshCw, AlertCircle,
  Package, Sparkles, Rss, Send, ChevronRight, ChevronDown, CheckCircle2, XCircle,
} from "lucide-react";

const VariantStockCard = ({ variant, tenantId, productSku }: { variant: any; tenantId: string; productSku: string }) => {
  const queryClient = useQueryClient();
  const currentStock = variant.stock_totals?.qty ?? 0;
  const [stockValue, setStockValue] = useState<string>(currentStock.toString());
  const [isEditing, setIsEditing] = useState(false);

  const updateStockMutation = useMutation({
    mutationFn: async (newQty: number) => {
      const { error: stockError } = await supabase.from("stock_totals").upsert({ variant_id: variant.id, qty: newQty, updated_at: new Date().toISOString() }, { onConflict: "variant_id" });
      if (stockError) throw stockError;
      const { error: jobError } = await supabase.from("jobs").insert({ type: "SYNC_TO_WOO", state: "ready", tenant_id: tenantId, payload: { variantIds: [variant.id] } });
      if (jobError) throw jobError;
    },
    onSuccess: () => { toast.success(`Voorraad bijgewerkt naar ${stockValue}`); queryClient.invalidateQueries({ queryKey: ["product-detail"] }); setIsEditing(false); },
    onError: (error: any) => toast.error(`Update mislukt: ${error.message}`),
  });

  const handleSave = () => {
    const n = parseInt(stockValue, 10);
    if (isNaN(n) || n < 0) { toast.error("Ongeldig aantal"); return; }
    if (n === currentStock) { setIsEditing(false); return; }
    updateStockMutation.mutate(n);
  };

  return (
    <div className="flex items-center justify-between py-3 border-b border-border/60 last:border-0">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium w-20">{variant.size_label}</span>
        {variant.maat_web && variant.maat_web !== variant.size_label && (
          <span className="text-xs text-muted-foreground">(Web: {variant.maat_web})</span>
        )}
        <span className="text-xs font-mono text-muted-foreground">{variant.ean || "—"}</span>
        <Badge variant={variant.active ? "secondary" : "outline"} className="text-[11px]">
          {variant.active ? "Actief" : "Inactief"}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        {isEditing ? (
          <>
            <Input type="number" min="0" value={stockValue} onChange={(e) => setStockValue(e.target.value)} className="w-20 h-8 text-center" autoFocus />
            <Button size="sm" onClick={handleSave} disabled={updateStockMutation.isPending}>{updateStockMutation.isPending ? "..." : "OK"}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setStockValue(currentStock.toString()); setIsEditing(false); }}>✕</Button>
          </>
        ) : (
          <Badge variant={currentStock > 0 ? "default" : "destructive"} className="cursor-pointer hover:opacity-80 min-w-[60px] justify-center" onClick={() => setIsEditing(true)}>
            {currentStock}
          </Badge>
        )}
      </div>
    </div>
  );
};

const wooFieldMapping = [
  { label: "Title", dbField: "title", wooField: "name" },
  { label: "SKU", dbField: "sku", wooField: "sku" },
  { label: "Price", dbField: "product_prices.regular", wooField: "regular_price" },
  { label: "List Price", dbField: "product_prices.list", wooField: "sale_price" },
  { label: "Tax Code", dbField: "tax_code", wooField: "tax_class" },
  { label: "URL Key", dbField: "url_key", wooField: "slug" },
];

const ProductDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: product, isLoading } = useQuery({
    queryKey: ["product-detail", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*, brands(id, name), suppliers(id, name), product_prices(*), variants(*, stock_totals(*))")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  const [editedFields, setEditedFields] = useState<Record<string, any>>({});
  const edited = product ? { ...product, ...editedFields, product_prices: { ...product.product_prices, ...(editedFields.product_prices || {}) } } : null;
  const hasChanges = Object.keys(editedFields).length > 0;
  const setField = (field: string, value: any) => setEditedFields((prev) => ({ ...prev, [field]: value }));
  const setPriceField = (field: string, value: any) => setEditedFields((prev) => ({ ...prev, product_prices: { ...(prev.product_prices || {}), [field]: value } }));

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!product || !edited) return;
      const { error: pErr } = await supabase.from("products").update({ title: edited.title, sku: edited.sku, tax_code: edited.tax_code, url_key: edited.url_key }).eq("id", product.id);
      if (pErr) throw pErr;
      if (editedFields.product_prices) {
        const { error: prErr } = await supabase.from("product_prices").update({ regular: edited.product_prices.regular, list: edited.product_prices.list }).eq("product_id", product.id);
        if (prErr) throw prErr;
      }
    },
    onSuccess: () => { toast.success("Product opgeslagen"); setEditedFields({}); queryClient.invalidateQueries({ queryKey: ["product-detail", id] }); queryClient.invalidateQueries({ queryKey: ["products"] }); },
    onError: (e: any) => toast.error(`Opslaan mislukt: ${e.message}`),
  });

  const { data: compareData, isLoading: isComparing, refetch: refetchCompare } = useQuery({
    queryKey: ["product-compare", id],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("compare-product", { body: { productId: id, tenantId: product?.tenant_id } });
      if (error) throw error;
      return data;
    },
    enabled: false,
  });

  if (isLoading) {
    return <Layout><div className="flex items-center justify-center py-20"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div></Layout>;
  }

  if (!product) {
    return (
      <Layout>
        <div className="text-center py-20">
          <p className="text-muted-foreground">Product niet gevonden</p>
          <Button variant="ghost" className="mt-4" onClick={() => navigate("/products")}><ArrowLeft className="h-4 w-4 mr-2" /> Terug</Button>
        </div>
      </Layout>
    );
  }

  const totalStock = product.variants?.reduce((sum: number, v: any) => sum + (v.stock_totals?.qty ?? 0), 0) ?? 0;
  const images = Array.isArray(product.images) ? (product.images as string[]) : [];
  const imageCount = images.length;
  const variantCount = product.variants?.length ?? 0;
  const price = Number(product.product_prices?.regular || 0);
  const color = product.color as Record<string, any> | null;
  const attrs = product.attributes as Record<string, any> | null;
  const productTags = Array.isArray(product.tags) ? (product.tags as string[]) : [];

  return (
    <Layout>
      <div className="space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/products" className="hover:text-foreground transition-colors">Products</Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground font-medium truncate max-w-[300px]">{product.title}</span>
        </div>

        {/* Hero */}
        <div className="flex items-start gap-5">
          <div className="h-24 w-24 rounded-xl border border-border bg-muted/50 flex items-center justify-center flex-shrink-0 overflow-hidden">
            {images.length > 0 ? (
              <img src={images[0]} alt={product.title} className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).src = "/placeholder.svg"; }} />
            ) : (
              <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold truncate">{product.title}</h1>
            <div className="flex items-center gap-3 mt-1.5 text-sm text-muted-foreground">
              <span className="font-mono">{product.sku}</span>
              <span>•</span>
              <span>{product.brands?.name || "Geen merk"}</span>
              <span>•</span>
              <span>€{price.toFixed(2)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {totalStock > 0 ? <span className="badge-success">● {totalStock} op voorraad</span> : <span className="badge-error">● Niet op voorraad</span>}
              <span className="badge-info">{variantCount} varianten</span>
              {imageCount > 0 ? <span className="badge-neutral">{imageCount} afbeeldingen</span> : <span className="badge-warning">Geen afbeeldingen</span>}
              {productTags.map((t) => <Badge key={t} variant="outline" className="text-[11px]">{t}</Badge>)}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={() => navigate("/products")}><ArrowLeft className="h-4 w-4 mr-1" /> Terug</Button>
            {hasChanges && (
              <Button size="sm" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
                <Save className="h-4 w-4 mr-1" /> {updateMutation.isPending ? "Opslaan..." : "Opslaan"}
              </Button>
            )}
          </div>
        </div>

        {/* Completeness Score */}
        {(() => {
          const { score, checks } = calculateCompleteness(product);
          const passed = checks.filter((c) => c.passed).length;
          return (
            <Collapsible>
              <Card className={`${scoreBg(score)} border-0`}>
                <CollapsibleTrigger className="w-full">
                  <CardContent className="py-3 px-4 flex items-center gap-4">
                    <div className={`text-2xl font-bold ${scoreColor(score)}`}>{score}%</div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">Completeness — {passed}/{checks.length} checks</span>
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-180" />
                      </div>
                      <Progress value={score} className="h-1.5" />
                    </div>
                  </CardContent>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-4 pb-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
                    {checks.map((check) => (
                      <div key={check.label} className="flex items-center gap-2 text-sm">
                        {check.passed ? (
                          <CheckCircle2 className="h-4 w-4 text-success flex-shrink-0" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                        )}
                        <span className={check.passed ? "text-muted-foreground" : "font-medium"}>
                          {check.label}
                        </span>
                        <span className="text-xs text-muted-foreground ml-auto">{check.weight}%</span>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          );
        })()}

        {/* Tabs */}
        <Tabs defaultValue="info" className="space-y-4">
          <TabsList>
            <TabsTrigger value="info">Info</TabsTrigger>
            <TabsTrigger value="content">Content & SEO</TabsTrigger>
            <TabsTrigger value="ai" className="flex items-center gap-1"><Sparkles className="h-3 w-3" /> AI</TabsTrigger>
            <TabsTrigger value="variants">Varianten ({variantCount})</TabsTrigger>
            <TabsTrigger value="images">Afbeeldingen ({imageCount})</TabsTrigger>
            <TabsTrigger value="channels">Channel Preview</TabsTrigger>
            <TabsTrigger value="compare">Vergelijk</TabsTrigger>
          </TabsList>

          {/* INFO */}
          <TabsContent value="info" className="space-y-6">
            <Card className="card-elevated">
              <CardHeader><CardTitle className="text-base">Productgegevens</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Titel</Label><Input value={edited?.title || ""} onChange={(e) => setField("title", e.target.value)} /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">SKU</Label><Input value={edited?.sku || ""} onChange={(e) => setField("sku", e.target.value)} /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Merk</Label><Input value={product.brands?.name || "N/A"} disabled /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Leverancier</Label><Input value={product.suppliers?.name || "N/A"} disabled /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Tax Code</Label><Input value={edited?.tax_code || ""} onChange={(e) => setField("tax_code", e.target.value)} /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">URL Key</Label><Input value={edited?.url_key || ""} onChange={(e) => setField("url_key", e.target.value)} /></div>
              </CardContent>
            </Card>
            <Card className="card-elevated">
              <CardHeader><CardTitle className="text-base">Prijzen</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Reguliere prijs (€)</Label><Input type="number" step="0.01" value={edited?.product_prices?.regular ?? ""} onChange={(e) => setPriceField("regular", e.target.value)} /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Adviesprijs (€)</Label><Input type="number" step="0.01" value={edited?.product_prices?.list ?? ""} onChange={(e) => setPriceField("list", e.target.value)} /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Inkoopprijs (€)</Label><Input value={product.cost_price || "—"} disabled /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Korting (%)</Label><Input value={product.discount_percentage || "0"} disabled /></div>
              </CardContent>
            </Card>
            {color && (
              <Card className="card-elevated">
                <CardHeader><CardTitle className="text-base">Kleur</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-muted-foreground">Kleur:</span> <span className="font-medium ml-2">{color.label || "—"}</span></div>
                  <div><span className="text-muted-foreground">Filter:</span> <span className="font-medium ml-2">{color.filter || "—"}</span></div>
                </CardContent>
              </Card>
            )}
            {attrs && Object.keys(attrs).length > 0 && (
              <Card className="card-elevated">
                <CardHeader><CardTitle className="text-base">Eigenschappen</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                  {Object.entries(attrs).map(([key, value]) => (
                    <div key={key}><span className="text-muted-foreground">{key}:</span> <span className="font-medium ml-1">{String(value)}</span></div>
                  ))}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* CONTENT & SEO */}
          <TabsContent value="content" className="space-y-6">
            <Card className="card-elevated">
              <CardHeader><CardTitle className="text-base">Product Beschrijvingen</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Interne Omschrijving</Label><Input value={product.internal_description || ""} disabled /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Beschrijving (NL)</Label><Textarea value={product.webshop_text || ""} disabled rows={5} /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Beschrijving (EN)</Label><Textarea value={product.webshop_text_en || ""} disabled rows={5} /></div>
              </CardContent>
            </Card>
            <Card className="card-elevated">
              <CardHeader><CardTitle className="text-base">SEO</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Meta Title</Label><Input value={product.meta_title || ""} disabled /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Meta Keywords</Label><Input value={product.meta_keywords || ""} disabled /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Meta Description</Label><Textarea value={product.meta_description || ""} disabled rows={3} /></div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* AI */}
          <TabsContent value="ai"><AiContentTab product={product} /></TabsContent>

          {/* VARIANTS */}
          <TabsContent value="variants">
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span>Varianten & Voorraad</span>
                  <span className="badge-info">{totalStock} totaal</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {product.variants && product.variants.length > 0 ? (
                  <div>
                    <div className="flex items-center justify-between py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground border-b border-border">
                      <div className="flex items-center gap-4"><span className="w-20">Maat</span><span className="w-32">EAN</span><span>Status</span></div>
                      <span className="w-24 text-right">Voorraad</span>
                    </div>
                    {product.variants.map((v: any) => <VariantStockCard key={v.id} variant={v} tenantId={product.tenant_id} productSku={product.sku} />)}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground"><Package className="h-8 w-8 mx-auto mb-2 opacity-40" /><p className="text-sm">Geen varianten</p></div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* IMAGES */}
          <TabsContent value="images">
            {images.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {images.map((url, i) => (
                  <div key={i} className="card-elevated rounded-xl overflow-hidden">
                    <img src={url} alt={`${product.title} ${i + 1}`} className="w-full h-48 object-cover" onError={(e) => { (e.target as HTMLImageElement).src = "/placeholder.svg"; }} />
                    <div className="p-2"><p className="text-[11px] text-muted-foreground truncate">{String(url).split("/").pop()}</p></div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-muted/30 p-12 text-center">
                <ImageIcon className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm font-medium text-muted-foreground">Geen afbeeldingen</p>
              </div>
            )}
          </TabsContent>

          {/* CHANNEL PREVIEW */}
          <TabsContent value="channels" className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <Card className="card-elevated">
                <CardHeader className="flex flex-row items-center gap-2"><Rss className="h-4 w-4 text-muted-foreground" /><CardTitle className="text-base">Google Shopping</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div><span className="text-muted-foreground">Title:</span><p className="font-medium">{product.title}</p></div>
                  <div><span className="text-muted-foreground">Price:</span><p className="font-medium">€{price.toFixed(2)}</p></div>
                  <div className="flex items-center gap-2"><span className="text-muted-foreground">GTIN:</span>{product.variants?.some((v: any) => v.ean) ? <span className="badge-success">Aanwezig</span> : <span className="badge-warning">Ontbreekt</span>}</div>
                  <div className="flex items-center gap-2"><span className="text-muted-foreground">Afbeelding:</span>{imageCount > 0 ? <span className="badge-success">✓</span> : <span className="badge-error">Ontbreekt</span>}</div>
                  <div className="flex items-center gap-2"><span className="text-muted-foreground">Beschikbaarheid:</span>{totalStock > 0 ? <span className="badge-success">in_stock</span> : <span className="badge-warning">out_of_stock</span>}</div>
                </CardContent>
              </Card>
              <Card className="card-elevated">
                <CardHeader className="flex flex-row items-center gap-2"><Send className="h-4 w-4 text-muted-foreground" /><CardTitle className="text-base">WooCommerce</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {wooFieldMapping.map((m) => (
                    <div key={m.dbField} className="flex items-center justify-between">
                      <span className="text-muted-foreground">{m.label}:</span>
                      <span className="font-mono text-xs text-right max-w-[200px] truncate">
                        {m.dbField.includes(".") ? String((product.product_prices as any)?.[m.dbField.split(".")[1]] || "—") : String((product as any)[m.dbField] || "—")}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* COMPARE */}
          <TabsContent value="compare">
            <Card className="card-elevated">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Database vs WooCommerce</CardTitle>
                  <Button onClick={() => refetchCompare()} disabled={isComparing} size="sm" variant="outline">
                    <RefreshCw className={`h-4 w-4 mr-1 ${isComparing ? "animate-spin" : ""}`} /> {isComparing ? "Vergelijken..." : "Vergelijk"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {!compareData && !isComparing && (
                  <div className="text-center py-8 text-muted-foreground"><AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-40" /><p className="text-sm">Klik op "Vergelijk"</p></div>
                )}
                {isComparing && <div className="text-center py-8"><RefreshCw className="h-8 w-8 mx-auto mb-2 animate-spin text-muted-foreground" /></div>}
                {compareData && !isComparing && (
                  <div className="space-y-3">
                    {!compareData.differences?.exists && <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>Product niet gevonden in WooCommerce.</AlertDescription></Alert>}
                    {compareData.differences?.exists && Object.keys(compareData.differences.fields).length === 0 && <Alert><AlertDescription className="text-success">✓ Alle velden zijn synchroon</AlertDescription></Alert>}
                    {compareData.differences?.exists && Object.keys(compareData.differences.fields).length > 0 && (
                      <>
                        <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{Object.keys(compareData.differences.fields).length} verschil(len)</AlertDescription></Alert>
                        {Object.entries(compareData.differences.fields).map(([field, values]: [string, any]) => (
                          <div key={field} className="flex items-center gap-4 py-2 border-b border-border/60 text-sm">
                            <span className="font-medium w-32">{field}</span>
                            <div className="flex-1 grid grid-cols-2 gap-4">
                              <div><span className="text-[11px] text-muted-foreground">DB:</span><p className="font-mono text-xs">{values.database || "—"}</p></div>
                              <div><span className="text-[11px] text-muted-foreground">Woo:</span><p className="font-mono text-xs">{values.woocommerce || "—"}</p></div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
};

export default ProductDetail;
