import { useState, useCallback, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-function-client";
import { toast } from "sonner";
import { AiContentTab } from "@/components/AiContentTab";
import { ProductAttributesTab } from "@/components/ProductAttributesTab";
import {
  CheckCircle2, AlertTriangle, Lock, Unlock, Sparkles, FileText,
  Search as SearchIcon, Layers, Package, Send, AlertCircle,
} from "lucide-react";

// ── Source badge ──
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

// ── Lockable field wrapper ──
const LockableField = ({ fieldName, lockedFields, fieldSources, onToggleLock, children }: {
  fieldName: string; lockedFields: string[]; fieldSources: Record<string, string>; onToggleLock: (field: string) => void; children: React.ReactNode;
}) => {
  const isLocked = lockedFields.includes(fieldName);
  const source = fieldSources[fieldName];
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <div className="flex-1">{children}</div>
        <div className="flex items-center gap-1 mt-5">
          <SourceBadge source={source} />
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={() => onToggleLock(fieldName)}
                  className={`p-1 rounded-md transition-colors ${isLocked ? 'text-amber-500 hover:text-amber-600 bg-amber-500/10' : 'text-muted-foreground/30 hover:text-muted-foreground/60'}`}>
                  {isLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{isLocked ? 'Vergrendeld' : 'Ontgrendeld'}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
};

// ── Character counter ──
const CharCounter = ({ value, max, greenAbove }: { value: string; max: number; greenAbove: number }) => {
  const len = value.length;
  const color = len === 0 ? 'text-muted-foreground' : len >= greenAbove && len <= max ? 'text-emerald-600' : len > max ? 'text-destructive' : 'text-amber-500';
  return <span className={`text-[11px] ${color}`}>{len}/{max}</span>;
};

// ── Google Preview ──
const GooglePreview = ({ url, title, description }: { url: string; title: string; description: string }) => (
  <div className="rounded-lg border border-border bg-card p-3 space-y-0.5">
    <p className="text-[10px] text-muted-foreground font-medium mb-1">Google preview</p>
    <p className="text-sm text-blue-600 truncate">{title || 'Pagina titel'}</p>
    <p className="text-[11px] text-emerald-700 truncate">{url || 'https://www.example.com/product'}</p>
    <p className="text-xs text-muted-foreground line-clamp-2">{description || 'Meta description...'}</p>
  </div>
);

// ── Variant row (compact for modal) ──
const VariantRow = ({ variant, onUpdate }: { variant: any; onUpdate: (id: string, field: string, value: any) => void }) => {
  const stock = variant.stock_totals?.qty ?? 0;
  const stockColor = stock >= 3 ? 'bg-emerald-500/15 text-emerald-700 border-emerald-200' : stock >= 1 ? 'bg-amber-500/15 text-amber-700 border-amber-200' : 'bg-destructive/15 text-destructive border-destructive/20';
  return (
    <tr className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
      <td className="py-2 px-2 text-xs font-medium">{variant.size_label}</td>
      <td className="py-2 px-2"><Input className="h-6 text-[11px] w-20" defaultValue={variant.maat_web || ''} onBlur={(e) => { if (e.target.value !== (variant.maat_web || '')) onUpdate(variant.id, 'maat_web', e.target.value); }} /></td>
      <td className="py-2 px-2"><Input className="h-6 text-[11px] font-mono w-28" defaultValue={variant.ean || ''} onBlur={(e) => { if (e.target.value !== (variant.ean || '')) onUpdate(variant.id, 'ean', e.target.value); }} /></td>
      <td className="py-2 px-2 text-[11px] font-mono text-muted-foreground">{variant.maat_id}</td>
      <td className="py-2 px-2"><span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${stockColor}`}>{stock}</span></td>
      <td className="py-2 px-2 text-xs text-muted-foreground">€{Number(variant.price || 0).toFixed(2)}</td>
      <td className="py-2 px-2"><Switch className="scale-75" checked={variant.active} onCheckedChange={(v) => onUpdate(variant.id, 'active', v)} /></td>
      <td className="py-2 px-2"><Switch className="scale-75" checked={variant.allow_backorder || false} onCheckedChange={(v) => onUpdate(variant.id, 'allow_backorder', v)} /></td>
    </tr>
  );
};

interface ProductDetailModalProps {
  product: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ProductDetailModal = ({ product, open, onOpenChange }: ProductDetailModalProps) => {
  const queryClient = useQueryClient();
  const [editedFields, setEditedFields] = useState<Record<string, any>>({});
  const [pendingLockChanges, setPendingLockChanges] = useState<Record<string, boolean>>({});
  const [savedIndicator, setSavedIndicator] = useState(false);

  const edited = product ? { ...product, ...editedFields } : null;
  const setField = (field: string, value: any) => setEditedFields((prev) => ({ ...prev, [field]: value }));

  // Locked fields
  const currentLockedFields: string[] = Array.isArray(product?.locked_fields) ? product.locked_fields : [];
  const fieldSources: Record<string, string> = product?.field_sources || {};
  const effectiveLockedFields = (() => {
    const fields = new Set(currentLockedFields);
    for (const [field, locked] of Object.entries(pendingLockChanges)) {
      if (locked) fields.add(field); else fields.delete(field);
    }
    return Array.from(fields);
  })();
  const toggleLock = (field: string) => {
    const isCurrentlyLocked = effectiveLockedFields.includes(field);
    setPendingLockChanges((prev) => ({ ...prev, [field]: !isCurrentlyLocked }));
  };

  // ── Debounced auto-save ──
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const autoSave = useCallback(async (fieldsToSave: Record<string, any>) => {
    if (!product) return;
    const newLockedFields = new Set(effectiveLockedFields);
    const newFieldSources: Record<string, string> = { ...fieldSources };
    for (const field of Object.keys(fieldsToSave)) {
      if (field !== 'product_type') {
        newLockedFields.add(field);
        newFieldSources[field] = 'manual';
      }
    }
    const updateFields: any = { locked_fields: Array.from(newLockedFields), field_sources: newFieldSources };
    const simpleFields = ['title', 'short_description', 'webshop_text', 'webshop_text_en', 'meta_title', 'meta_description', 'focus_keyword', 'product_type', 'publication_status'];
    for (const f of simpleFields) {
      if (f in fieldsToSave) updateFields[f] = fieldsToSave[f];
    }
    const { error } = await supabase.from("products").update(updateFields).eq("id", product.id);
    if (error) { toast.error(`Opslaan mislukt: ${error.message}`); return; }
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 2000);
    queryClient.invalidateQueries({ queryKey: ["products"] });
    queryClient.invalidateQueries({ queryKey: ["product-detail", product.id] });
  }, [product, effectiveLockedFields, fieldSources, queryClient]);

  useEffect(() => {
    if (Object.keys(editedFields).length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      autoSave(editedFields);
      setEditedFields({});
      setPendingLockChanges({});
    }, 1000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [editedFields, autoSave]);

  // Reset state when product changes
  useEffect(() => {
    setEditedFields({});
    setPendingLockChanges({});
  }, [product?.id]);

  // ── Variant update ──
  const updateVariantMutation = useMutation({
    mutationFn: async ({ variantId, field, value }: { variantId: string; field: string; value: any }) => {
      const { error } = await supabase.from("variants").update({ [field]: value }).eq("id", variantId);
      if (error) throw error;
    },
    onSuccess: () => { setSavedIndicator(true); setTimeout(() => setSavedIndicator(false), 2000); queryClient.invalidateQueries({ queryKey: ["products"] }); },
    onError: (e: any) => toast.error(`Update mislukt: ${e.message}`),
  });

  // ── Publish mutation ──
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishSuccess, setPublishSuccess] = useState(false);

  const pushToWooMutation = useMutation({
    mutationFn: async () => {
      if (!product) throw new Error("Geen product");
      setPublishError(null);
      setPublishSuccess(false);
      const resp = await invokeEdgeFunction("push-to-woocommerce", {
        tenantId: product.tenant_id,
        productIds: [product.id],
        syncScope: "FULL",
      });
      if (resp?.error) throw new Error(typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error));
      return resp;
    },
    onSuccess: () => {
      setPublishSuccess(true);
      toast.success("Product gepubliceerd naar WooCommerce");
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setTimeout(() => setPublishSuccess(false), 4000);
    },
    onError: (e: any) => {
      setPublishError(e.message || "Onbekende fout bij publicatie");
      toast.error(`Publicatie mislukt: ${e.message}`);
    },
  });

  if (!product) return null;

  const isVariable = (edited?.product_type || product.product_type) !== 'simple';
  const totalStock = product.variants?.reduce((sum: number, v: any) => sum + (v.stock_totals?.qty ?? 0), 0) ?? 0;
  const price = Number(product.product_prices?.regular || 0);
  const wooUrl = product.woo_permalink || (product.url_key ? `https://www.example.com/${product.url_key}` : '');
  const variantsWithoutEan = isVariable ? (product.variants || []).filter((v: any) => v.active && (!v.ean || v.ean === '0' || v.ean === '')).length : 0;

  // Completeness
  const publishFields = [
    { name: 'title', filled: !!product.title?.trim() },
    { name: 'short_description', filled: !!product.short_description?.trim() },
    { name: 'webshop_text', filled: !!product.webshop_text?.trim() },
    { name: 'meta_title', filled: !!product.meta_title?.trim() },
    { name: 'meta_description', filled: !!product.meta_description?.trim() },
    { name: 'focus_keyword', filled: !!product.focus_keyword?.trim() },
  ];
  const filledCount = publishFields.filter(f => f.filled).length;
  const missingFields = publishFields.filter(f => !f.filled);
  const pubStatus = product.publication_status || 'concept';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">{product.title}</span>
              <Badge variant="outline" className="text-[10px] flex-shrink-0">{product.sku}</Badge>
              {savedIndicator && <span className="text-xs text-emerald-600 flex items-center gap-1 flex-shrink-0"><CheckCircle2 className="h-3 w-3" /> Opgeslagen</span>}
            </div>
            <Select value={edited?.product_type || "variable"} onValueChange={(v) => setField("product_type", v)}>
              <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="variable">Variable</SelectItem>
                <SelectItem value="simple">Simple</SelectItem>
              </SelectContent>
            </Select>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="content" className="w-full">
          <TabsList className="flex w-full">
            <TabsTrigger value="content" className="flex items-center gap-1 text-xs"><FileText className="h-3 w-3" /> Content</TabsTrigger>
            <TabsTrigger value="seo" className="flex items-center gap-1 text-xs"><SearchIcon className="h-3 w-3" /> SEO</TabsTrigger>
            {isVariable && <TabsTrigger value="variants" className="flex items-center gap-1 text-xs"><Layers className="h-3 w-3" /> Varianten ({product.variants?.length || 0})</TabsTrigger>}
            <TabsTrigger value="eigenschappen" className="flex items-center gap-1 text-xs"><Package className="h-3 w-3" /> Eigenschappen</TabsTrigger>
          </TabsList>

          {/* ── TAB 1: Content ── */}
          <TabsContent value="content" className="space-y-3 mt-3">
            <LockableField fieldName="title" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
              <Label className="text-xs text-muted-foreground">Paginatitel</Label>
              <Input className="h-8 text-sm" value={edited?.title || ""} onChange={(e) => setField("title", e.target.value)} />
            </LockableField>

            <LockableField fieldName="short_description" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
              <Label className="text-xs text-muted-foreground">Korte omschrijving</Label>
              <Textarea rows={2} className="text-sm" value={edited?.short_description || ""} onChange={(e) => setField("short_description", e.target.value)} placeholder="Korte samenvatting" />
            </LockableField>

            <LockableField fieldName="webshop_text" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Lange omschrijving (NL)</Label>
                <Button size="sm" variant="ghost" className="h-5 text-[11px] gap-1 text-primary"><Sparkles className="h-3 w-3" /> AI genereren</Button>
              </div>
              <Textarea rows={3} className="text-sm" value={edited?.webshop_text || ""} onChange={(e) => setField("webshop_text", e.target.value)} placeholder="Productomschrijving NL" />
            </LockableField>

            <LockableField fieldName="webshop_text_en" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Lange omschrijving (EN)</Label>
                <Button size="sm" variant="ghost" className="h-5 text-[11px] gap-1 text-primary"><Sparkles className="h-3 w-3" /> AI vertalen</Button>
              </div>
              <Textarea rows={2} className="text-sm" value={edited?.webshop_text_en || ""} onChange={(e) => setField("webshop_text_en", e.target.value)} placeholder="Product description EN" />
            </LockableField>

            {!isVariable && (
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/50">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Voorraad</Label>
                  <Badge variant={totalStock > 0 ? "default" : "destructive"}>{totalStock}</Badge>
                  <span className="text-[10px] text-muted-foreground ml-1">uit Modis</span>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Prijs</Label>
                  <span className="text-sm font-medium">€{price.toFixed(2)}</span>
                  <span className="text-[10px] text-muted-foreground ml-1">uit Modis</span>
                </div>
              </div>
            )}

            <AiContentTab product={product} />
          </TabsContent>

          {/* ── TAB 2: SEO ── */}
          <TabsContent value="seo" className="space-y-3 mt-3">
            <GooglePreview
              url={wooUrl}
              title={edited?.meta_title || product.meta_title || edited?.title || product.title || ''}
              description={edited?.meta_description || product.meta_description || ''}
            />

            <LockableField fieldName="focus_keyword" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Focus keyword</Label>
                <span className="text-[10px] text-muted-foreground">→ rank_math_focus_keyword</span>
              </div>
              <Input className="h-8 text-sm" value={edited?.focus_keyword || ""} onChange={(e) => setField("focus_keyword", e.target.value)} placeholder="Bijv. zwarte laarzen dames" />
            </LockableField>

            <LockableField fieldName="meta_title" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Meta title</Label>
                <CharCounter value={edited?.meta_title || ""} max={70} greenAbove={50} />
              </div>
              <Input className="h-8 text-sm" maxLength={70} value={edited?.meta_title || ""} onChange={(e) => setField("meta_title", e.target.value)} placeholder="SEO titel (max 70 tekens)" />
            </LockableField>

            <LockableField fieldName="meta_description" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Meta description</Label>
                <CharCounter value={edited?.meta_description || ""} max={160} greenAbove={120} />
              </div>
              <Textarea rows={2} className="text-sm" maxLength={160} value={edited?.meta_description || ""} onChange={(e) => setField("meta_description", e.target.value)} placeholder="SEO beschrijving (max 160 tekens)" />
            </LockableField>
          </TabsContent>

          {/* ── TAB 3: Varianten ── */}
          {isVariable && (
            <TabsContent value="variants" className="mt-3">
              {product.variants && product.variants.length > 0 ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          <th className="py-1.5 px-2 text-left">Maat</th>
                          <th className="py-1.5 px-2 text-left">Maat web</th>
                          <th className="py-1.5 px-2 text-left">EAN</th>
                          <th className="py-1.5 px-2 text-left">SKU</th>
                          <th className="py-1.5 px-2 text-left">Voorraad</th>
                          <th className="py-1.5 px-2 text-left">Prijs</th>
                          <th className="py-1.5 px-2 text-left">Actief</th>
                          <th className="py-1.5 px-2 text-left">Backorder</th>
                        </tr>
                      </thead>
                      <tbody>
                        {product.variants.map((v: any) => (
                          <VariantRow key={v.id} variant={{ ...v, price: product.product_prices?.regular }} onUpdate={(id, field, value) => updateVariantMutation.mutate({ variantId: id, field, value })} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> Maten, voorraad en prijs komen uit Modis en zijn niet bewerkbaar
                  </p>
                </>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <Package className="h-6 w-6 mx-auto mb-1 opacity-40" />
                  <p className="text-sm">Geen varianten</p>
                </div>
              )}
            </TabsContent>
          )}

          {/* ── TAB 4: Eigenschappen ── */}
          <TabsContent value="eigenschappen" className="space-y-3 mt-3">
            <ProductAttributesTab product={product} section="attributes" />
            <ProductAttributesTab product={product} section="categories" />
            {(product.color || product.brands) && (
              <Card>
                <CardHeader className="py-2"><CardTitle className="text-sm">Modis velden (read-only)</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-xs">
                  {product.brands?.name && <div><span className="text-muted-foreground">Merk:</span> <span className="font-medium ml-1">{product.brands.name}</span> <SourceBadge source="modis" /></div>}
                  {product.color && (
                    <>
                      <div><span className="text-muted-foreground">Kleur (webshop):</span> <span className="font-medium ml-1">{(product.color as any)?.webshop || '—'}</span> <SourceBadge source="modis" /></div>
                      <div><span className="text-muted-foreground">Kleur (artikel):</span> <span className="font-medium ml-1">{(product.color as any)?.article || '—'}</span> <SourceBadge source="modis" /></div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>

        {/* ═══════ PUBLICATION BAR ═══════ */}
        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium">{filledCount} van 6 velden ingevuld</span>
                <Badge variant={pubStatus === 'published' ? 'default' : pubStatus === 'ready' ? 'secondary' : 'outline'} className="text-[10px]">
                  {pubStatus === 'published' ? 'Gepubliceerd' : pubStatus === 'ready' ? 'Klaar' : 'Concept'}
                </Badge>
              </div>
              <Progress value={(filledCount / 6) * 100} className="h-1" />
            </div>
            <div className="flex items-center gap-2 ml-4">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setField("publication_status", "ready")} disabled={pubStatus === 'ready' || pubStatus === 'published'}>
                Markeer als klaar
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => {
                setField("publication_status", "published");
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                setTimeout(() => pushToWooMutation.mutate(), 200);
              }} disabled={filledCount < 4 || pushToWooMutation.isPending}>
                <Send className="h-3 w-3 mr-1" />
                {pushToWooMutation.isPending ? "Bezig..." : "Publiceer"}
              </Button>
            </div>
          </div>
          {missingFields.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {missingFields.map(f => (
                <span key={f.name} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/10 text-amber-700 border border-amber-200">
                  <AlertTriangle className="h-2.5 w-2.5" /> {f.name.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}
          {isVariable && variantsWithoutEan > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/10 text-amber-700 border border-amber-200">
              <AlertTriangle className="h-2.5 w-2.5" /> {variantsWithoutEan} variant(en) zonder EAN
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
