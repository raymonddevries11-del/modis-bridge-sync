import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { AiContentTab } from "@/components/AiContentTab";
import { ProductAttributesTab } from "@/components/ProductAttributesTab";
import { calculateCompleteness, scoreColor, scoreBg } from "@/lib/completeness";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Image as ImageIcon, RefreshCw, AlertCircle, AlertTriangle,
  Package, Sparkles, Rss, Send, ChevronRight, ChevronDown, CheckCircle2, XCircle,
  Plus, Lock, Unlock,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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

  const hasEan = variant.ean && variant.ean !== "0" && variant.ean !== "";

  return (
    <div className={`flex items-center justify-between py-3 border-b border-border/60 last:border-0 ${!hasEan ? "bg-destructive/5" : ""}`}>
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium w-20">{variant.size_label}</span>
        {hasEan ? (
          <span className="text-xs font-mono text-muted-foreground w-32">{variant.ean}</span>
        ) : (
          <span className="text-xs text-destructive font-medium w-32 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Geen EAN
          </span>
        )}
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

const CreateVariantsFromAttributes = ({ product }: { product: any }) => {
  const queryClient = useQueryClient();
  const attrs = product.attributes as Record<string, any> | null;
  const maatStr = attrs?.Maat as string | undefined;

  const parseSizes = (maat: string): string[] => {
    // Format: "35 = 2½, 36 = 3, 36.5 = 3½, 37 = 4, ..."
    return maat.split(",").map((s) => s.trim()).filter(Boolean);
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!maatStr) throw new Error("Geen Maat attribuut gevonden");
      const sizes = parseSizes(maatStr);
      if (sizes.length === 0) throw new Error("Geen maten gevonden");

      const variants = sizes.map((sizeEntry) => {
        // Extract EU size as size_label (part before " = ")
        const euSize = sizeEntry.split("=")[0].trim();
        return {
          product_id: product.id,
          size_label: euSize,
          maat_web: sizeEntry,
          maat_id: `${product.sku}-${euSize.replace(/[^0-9.]/g, "")}`,
          active: true,
        };
      });

      const { data, error } = await supabase.from("variants").insert(variants).select();
      if (error) throw error;

      // Create stock_totals entries for new variants
      if (data && data.length > 0) {
        const stockEntries = data.map((v: any) => ({
          variant_id: v.id,
          qty: 0,
          updated_at: new Date().toISOString(),
        }));
        const { error: stockErr } = await supabase.from("stock_totals").insert(stockEntries);
        if (stockErr) throw stockErr;
      }

      return data;
    },
    onSuccess: (data) => {
      toast.success(`${data?.length || 0} varianten aangemaakt`);
      queryClient.invalidateQueries({ queryKey: ["product-detail", product.id] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  if (!maatStr) return null;
  const sizes = parseSizes(maatStr);

  return (
    <Button size="sm" variant="outline" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
      <Plus className="h-4 w-4 mr-1" />
      {createMutation.isPending ? "Aanmaken..." : `${sizes.length} varianten aanmaken`}
    </Button>
  );
};
// Source badge config
const sourceConfig: Record<string, { label: string; className: string }> = {
  modis: { label: 'Modis', className: 'bg-blue-500/10 text-blue-600 border-blue-200' },
  'woocommerce-csv': { label: 'WooCommerce', className: 'bg-purple-500/10 text-purple-600 border-purple-200' },
  manual: { label: 'Handmatig', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-200' },
};

const SourceBadge = ({ source }: { source?: string }) => {
  if (!source) return null;
  const config = sourceConfig[source] || { label: source, className: 'bg-muted text-muted-foreground border-border' };
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${config.className}`}>{config.label}</span>;
};

// Lockable field wrapper with source indicator
const LockableField = ({ fieldName, lockedFields, fieldSources, onToggleLock, children }: {
  fieldName: string;
  lockedFields: string[];
  fieldSources: Record<string, string>;
  onToggleLock: (field: string) => void;
  children: React.ReactNode;
}) => {
  const isLocked = lockedFields.includes(fieldName);
  const source = fieldSources[fieldName];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex-1">{children}</div>
        <div className="flex items-center gap-1 mt-5">
          <SourceBadge source={source} />
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onToggleLock(fieldName)}
                  className={`p-1 rounded-md transition-colors ${isLocked ? 'text-amber-500 hover:text-amber-600 bg-amber-500/10' : 'text-muted-foreground/30 hover:text-muted-foreground/60'}`}
                >
                  {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isLocked ? 'Vergrendeld — wordt niet overschreven bij import. Klik om te ontgrendelen.' : 'Ontgrendeld — kan overschreven worden bij import. Klik om te vergrendelen.'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
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

  const { data: aiContentForScore } = useQuery({
    queryKey: ["ai-content", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_ai_content")
        .select("*")
        .eq("product_id", id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  const { data: allBrands } = useQuery({
    queryKey: ["brands"],
    queryFn: async () => {
      const { data, error } = await supabase.from("brands").select("id, name").order("name");
      if (error) throw error;
      return data;
    },
  });

  const [brandPopoverOpen, setBrandPopoverOpen] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");

  const [editedFields, setEditedFields] = useState<Record<string, any>>({});
  const [pendingLockChanges, setPendingLockChanges] = useState<Record<string, boolean>>({});
  const edited = product ? { ...product, ...editedFields, product_prices: { ...product.product_prices, ...(editedFields.product_prices || {}) } } : null;
  const hasChanges = Object.keys(editedFields).length > 0 || Object.keys(pendingLockChanges).length > 0;
  const setField = (field: string, value: any) => setEditedFields((prev) => ({ ...prev, [field]: value }));
  const setPriceField = (field: string, value: any) => setEditedFields((prev) => ({ ...prev, product_prices: { ...(prev.product_prices || {}), [field]: value } }));

  // Locked fields logic
  const currentLockedFields: string[] = Array.isArray((product as any)?.locked_fields) ? (product as any).locked_fields : [];
  const fieldSources: Record<string, string> = (product as any)?.field_sources || {};
  const effectiveLockedFields = (() => {
    const fields = new Set(currentLockedFields);
    for (const [field, locked] of Object.entries(pendingLockChanges)) {
      if (locked) fields.add(field);
      else fields.delete(field);
    }
    return Array.from(fields);
  })();
  const toggleLock = (field: string) => {
    const isCurrentlyLocked = effectiveLockedFields.includes(field);
    setPendingLockChanges((prev) => ({ ...prev, [field]: !isCurrentlyLocked }));
  };

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!product || !edited) return;
      // Auto-lock any manually edited fields and update sources
      const newLockedFields = new Set(effectiveLockedFields);
      const newFieldSources: Record<string, string> = { ...fieldSources };
      for (const field of Object.keys(editedFields)) {
        if (field !== 'product_prices' && field !== 'product_type') {
          newLockedFields.add(field);
          newFieldSources[field] = 'manual';
        }
      }
      const updateFields: any = {
        title: edited.title, sku: edited.sku, tax_code: edited.tax_code, url_key: edited.url_key,
        locked_fields: Array.from(newLockedFields),
        field_sources: newFieldSources,
      };
      if (editedFields.product_type !== undefined) updateFields.product_type = editedFields.product_type;
      if (editedFields.brand_id !== undefined) { updateFields.brand_id = editedFields.brand_id; newLockedFields.add('brand_id'); newFieldSources['brand_id'] = 'manual'; updateFields.locked_fields = Array.from(newLockedFields); updateFields.field_sources = newFieldSources; }
      const { error: pErr } = await supabase.from("products").update(updateFields).eq("id", product.id);
      if (pErr) throw pErr;
      if (editedFields.product_prices) {
        const { error: prErr } = await supabase.from("product_prices").update({ regular: edited.product_prices.regular, list: edited.product_prices.list }).eq("product_id", product.id);
        if (prErr) throw prErr;
      }
    },
    onSuccess: () => { toast.success("Product opgeslagen"); setEditedFields({}); setPendingLockChanges({}); queryClient.invalidateQueries({ queryKey: ["product-detail", id] }); queryClient.invalidateQueries({ queryKey: ["products"] }); },
    onError: (e: any) => toast.error(`Opslaan mislukt: ${e.message}`),
  });

  // Save lock changes only (without field edits)
  const saveLocksMutation = useMutation({
    mutationFn: async () => {
      if (!product) return;
      const { error } = await supabase.from("products").update({ locked_fields: effectiveLockedFields } as any).eq("id", product.id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Veldvergrendelingen opgeslagen"); setPendingLockChanges({}); queryClient.invalidateQueries({ queryKey: ["product-detail", id] }); },
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
              <Badge variant="outline" className="text-[11px]">{(product as any).product_type === "simple" ? "Simple" : "Variable"}</Badge>
              {imageCount > 0 ? <span className="badge-neutral">{imageCount} afbeeldingen</span> : <span className="badge-warning">Geen afbeeldingen</span>}
              {productTags.map((t) => <Badge key={t} variant="outline" className="text-[11px]">{t}</Badge>)}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={() => navigate("/products")}><ArrowLeft className="h-4 w-4 mr-1" /> Terug</Button>
            {hasChanges && (
              <Button size="sm" onClick={() => {
                if (Object.keys(editedFields).length > 0) {
                  updateMutation.mutate();
                } else {
                  saveLocksMutation.mutate();
                }
              }} disabled={updateMutation.isPending || saveLocksMutation.isPending}>
                <Save className="h-4 w-4 mr-1" /> {(updateMutation.isPending || saveLocksMutation.isPending) ? "Opslaan..." : "Opslaan"}
              </Button>
            )}
          </div>
        </div>

        {/* Completeness Score */}
        {(() => {
          const { score, checks } = calculateCompleteness(product, aiContentForScore);
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
            <TabsTrigger value="attributes">Attributen</TabsTrigger>
            <TabsTrigger value="categories">Categorieën</TabsTrigger>
            <TabsTrigger value="variants">Varianten ({variantCount})</TabsTrigger>
            <TabsTrigger value="images">Afbeeldingen ({imageCount})</TabsTrigger>
            <TabsTrigger value="channels">Channel Preview</TabsTrigger>
            <TabsTrigger value="compare">Vergelijk</TabsTrigger>
          </TabsList>

          {/* INFO */}
          <TabsContent value="info" className="space-y-6">
            <Card className="card-elevated">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Productgegevens</CardTitle>
                  {effectiveLockedFields.length > 0 && (
                    <Badge variant="outline" className="text-[11px] gap-1 text-amber-600 border-amber-300">
                      <Lock className="h-3 w-3" /> {effectiveLockedFields.length} vergrendeld
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                <LockableField fieldName="title" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <Label className="text-xs text-muted-foreground">Titel</Label><Input value={edited?.title || ""} onChange={(e) => setField("title", e.target.value)} />
                </LockableField>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">SKU</Label><Input value={edited?.sku || ""} onChange={(e) => setField("sku", e.target.value)} /></div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Merk</Label>
                  <Popover open={brandPopoverOpen} onOpenChange={setBrandPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" role="combobox" className="w-full justify-between font-normal h-9">
                        {editedFields.brand_id !== undefined
                          ? (allBrands?.find((b) => b.id === editedFields.brand_id)?.name || "—")
                          : (product.brands?.name || "Selecteer merk...")}
                        <ChevronDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[250px] p-0" align="start">
                      <Command shouldFilter={true}>
                        <CommandInput placeholder="Zoek merk..." value={brandSearch} onValueChange={setBrandSearch} />
                        <CommandList>
                          <CommandEmpty>
                            <button
                              className="w-full px-2 py-1.5 text-sm text-left hover:bg-accent rounded-sm flex items-center gap-2"
                              onClick={async () => {
                                const name = brandSearch.trim();
                                if (!name) return;
                                const { data, error } = await supabase.from("brands").insert({ name }).select("id").single();
                                if (error) { toast.error(`Merk aanmaken mislukt: ${error.message}`); return; }
                                queryClient.invalidateQueries({ queryKey: ["brands"] });
                                setField("brand_id", data.id);
                                setBrandSearch("");
                                setBrandPopoverOpen(false);
                                toast.success(`Merk "${name}" aangemaakt`);
                              }}
                            >
                              <Plus className="h-3.5 w-3.5" /> "{brandSearch}" aanmaken
                            </button>
                          </CommandEmpty>
                          <CommandGroup>
                            {allBrands?.map((brand) => (
                              <CommandItem key={brand.id} value={brand.name} onSelect={() => { setField("brand_id", brand.id); setBrandPopoverOpen(false); setBrandSearch(""); }}>
                                {brand.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Leverancier</Label><Input value={product.suppliers?.name || "N/A"} disabled /></div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Product type</Label>
                  <Select value={edited?.product_type || "variable"} onValueChange={(v) => setField("product_type", v)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="variable">Variable (met maten)</SelectItem>
                      <SelectItem value="simple">Simple (zonder maten)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <LockableField fieldName="tax_code" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <Label className="text-xs text-muted-foreground">Tax Code</Label><Input value={edited?.tax_code || ""} onChange={(e) => setField("tax_code", e.target.value)} />
                </LockableField>
                <LockableField fieldName="url_key" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <Label className="text-xs text-muted-foreground">URL Key</Label><Input value={edited?.url_key || ""} onChange={(e) => setField("url_key", e.target.value)} />
                </LockableField>
              </CardContent>
            </Card>
            <Card className="card-elevated">
              <CardHeader><CardTitle className="text-base">Prijzen</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Reguliere prijs (€)</Label><Input type="number" step="0.01" value={edited?.product_prices?.regular ?? ""} onChange={(e) => setPriceField("regular", e.target.value)} /></div>
                <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">Sale prijs (€)</Label><Input type="number" step="0.01" value={edited?.product_prices?.list ?? ""} onChange={(e) => setPriceField("list", e.target.value)} /></div>
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
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2"><Label className="text-xs text-muted-foreground">Interne Omschrijving</Label><SourceBadge source={fieldSources['internal_description']} /></div>
                  <Input value={product.internal_description || ""} disabled />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2"><Label className="text-xs text-muted-foreground">Beschrijving (NL)</Label><SourceBadge source={fieldSources['webshop_text']} /></div>
                  <Textarea value={product.webshop_text || ""} disabled rows={5} />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2"><Label className="text-xs text-muted-foreground">Beschrijving (EN)</Label><SourceBadge source={fieldSources['webshop_text_en']} /></div>
                  <Textarea value={product.webshop_text_en || ""} disabled rows={5} />
                </div>
              </CardContent>
            </Card>
            <Card className="card-elevated">
              <CardHeader><CardTitle className="text-base">SEO</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2"><Label className="text-xs text-muted-foreground">Meta Title</Label><SourceBadge source={fieldSources['meta_title']} /></div>
                  <Input value={product.meta_title || ""} disabled />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2"><Label className="text-xs text-muted-foreground">Meta Keywords</Label><SourceBadge source={fieldSources['meta_keywords']} /></div>
                  <Input value={product.meta_keywords || ""} disabled />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2"><Label className="text-xs text-muted-foreground">Meta Description</Label><SourceBadge source={fieldSources['meta_description']} /></div>
                  <Textarea value={product.meta_description || ""} disabled rows={3} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* AI */}
          <TabsContent value="ai"><AiContentTab product={product} /></TabsContent>

          {/* ATTRIBUTES */}
          <TabsContent value="attributes">
            <ProductAttributesTab product={product} section="attributes" />
          </TabsContent>

          {/* CATEGORIES */}
          <TabsContent value="categories">
            <ProductAttributesTab product={product} section="categories" />
          </TabsContent>

          {/* VARIANTS */}
          <TabsContent value="variants">
            <Card className="card-elevated">
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span>Varianten & Voorraad</span>
                  <div className="flex items-center gap-2">
                    {(!product.variants || product.variants.length === 0) && attrs?.Maat && (
                      <CreateVariantsFromAttributes product={product} />
                    )}
                    <span className="badge-info">{totalStock} totaal</span>
                  </div>
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
                  <div className="text-center py-8 text-muted-foreground">
                    <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">Geen varianten</p>
                    {attrs?.Maat && <p className="text-xs mt-1">Maten gevonden in attributen — gebruik de knop hierboven om varianten aan te maken.</p>}
                  </div>
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
