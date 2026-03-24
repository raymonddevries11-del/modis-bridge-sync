import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-function-client";
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
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { AiContentTab } from "@/components/AiContentTab";
import { ProductAttributesTab } from "@/components/ProductAttributesTab";
import { calculateCompleteness, scoreColor, scoreBg } from "@/lib/completeness";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Image as ImageIcon, RefreshCw, AlertCircle, AlertTriangle,
  Package, Sparkles, Send, ChevronRight, ChevronDown, CheckCircle2, XCircle,
  Plus, Lock, Unlock, FileText, Search as SearchIcon, Layers, Database, Eye,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
                <button type="button" onClick={() => onToggleLock(fieldName)}
                  className={`p-1 rounded-md transition-colors ${isLocked ? 'text-amber-500 hover:text-amber-600 bg-amber-500/10' : 'text-muted-foreground/30 hover:text-muted-foreground/60'}`}>
                  {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isLocked ? 'Vergrendeld — wordt niet overschreven bij import.' : 'Ontgrendeld — kan overschreven worden bij import.'}
              </TooltipContent>
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
  <div className="rounded-lg border border-border bg-card p-4 space-y-1">
    <p className="text-[11px] text-muted-foreground font-medium mb-1">Google zoekresultaat preview</p>
    <p className="text-sm text-blue-600 truncate">{title || 'Pagina titel'}</p>
    <p className="text-xs text-emerald-700 truncate">{url || 'https://www.example.com/product'}</p>
    <p className="text-xs text-muted-foreground line-clamp-2">{description || 'Meta description verschijnt hier...'}</p>
  </div>
);

// ── Variant row ──
const VariantRow = ({ variant, onUpdate }: { variant: any; onUpdate: (id: string, field: string, value: any) => void }) => {
  const stock = variant.stock_totals?.qty ?? 0;
  const stockColor = stock >= 3 ? 'bg-emerald-500/15 text-emerald-700 border-emerald-200' : stock >= 1 ? 'bg-amber-500/15 text-amber-700 border-amber-200' : 'bg-destructive/15 text-destructive border-destructive/20';

  return (
    <tr className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
      <td className="py-2.5 px-3 text-sm font-medium">{variant.size_label}</td>
      <td className="py-2.5 px-3">
        <Input className="h-7 text-xs w-24" defaultValue={variant.maat_web || ''} onBlur={(e) => {
          if (e.target.value !== (variant.maat_web || '')) onUpdate(variant.id, 'maat_web', e.target.value);
        }} />
      </td>
      <td className="py-2.5 px-3">
        <Input className="h-7 text-xs font-mono w-32" defaultValue={variant.ean || ''} onBlur={(e) => {
          if (e.target.value !== (variant.ean || '')) onUpdate(variant.id, 'ean', e.target.value);
        }} />
      </td>
      <td className="py-2.5 px-3 text-xs font-mono text-muted-foreground">{variant.maat_id}</td>
      <td className="py-2.5 px-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${stockColor}`}>{stock}</span>
      </td>
      <td className="py-2.5 px-3 text-sm text-muted-foreground">€{Number(variant.price || 0).toFixed(2)}</td>
      <td className="py-2.5 px-3">
        <Switch checked={variant.active} onCheckedChange={(v) => onUpdate(variant.id, 'active', v)} />
      </td>
      <td className="py-2.5 px-3">
        <Switch checked={variant.allow_backorder || false} onCheckedChange={(v) => onUpdate(variant.id, 'allow_backorder', v)} />
      </td>
    </tr>
  );
};

// ── Create variants from attributes ──
const CreateVariantsFromAttributes = ({ product }: { product: any }) => {
  const queryClient = useQueryClient();
  const attrs = product.attributes as Record<string, any> | null;
  const maatStr = attrs?.Maat as string | undefined;
  const parseSizes = (maat: string) => maat.split(",").map((s) => s.trim()).filter(Boolean);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!maatStr) throw new Error("Geen Maat attribuut gevonden");
      const sizes = parseSizes(maatStr);
      if (sizes.length === 0) throw new Error("Geen maten gevonden");
      const variants = sizes.map((sizeEntry) => {
        const euSize = sizeEntry.split("=")[0].trim();
        return { product_id: product.id, size_label: euSize, maat_web: sizeEntry, maat_id: `${product.sku}-${euSize.replace(/[^0-9.]/g, "")}`, active: true };
      });
      const { data, error } = await supabase.from("variants").insert(variants).select();
      if (error) throw error;
      if (data?.length) {
        await supabase.from("stock_totals").insert(data.map((v: any) => ({ variant_id: v.id, qty: 0, updated_at: new Date().toISOString() })));
      }
      return data;
    },
    onSuccess: (data) => { toast.success(`${data?.length || 0} varianten aangemaakt`); queryClient.invalidateQueries({ queryKey: ["product-detail", product.id] }); },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  if (!maatStr) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
      <Plus className="h-4 w-4 mr-1" />{createMutation.isPending ? "Aanmaken..." : `${parseSizes(maatStr).length} varianten aanmaken`}
    </Button>
  );
};

// ═══════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════
const ProductDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── Data queries ──
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

  const { data: wooLink } = useQuery({
    queryKey: ["woo-link", id],
    queryFn: async () => {
      const { data } = await supabase.from("woo_products").select("woo_id, status, permalink, last_pushed_at").eq("product_id", id!).maybeSingle();
      return data;
    },
    enabled: !!id,
  });

  const { data: syncStatus } = useQuery({
    queryKey: ["sync-status", id],
    queryFn: async () => {
      const { data } = await supabase.from("product_sync_status").select("*").eq("product_id", id!).maybeSingle();
      return data;
    },
    enabled: !!id,
  });

  const { data: pendingSyncJob } = useQuery({
    queryKey: ["pending-sync-job", id],
    queryFn: async () => {
      const { data } = await supabase.from("jobs").select("id, state, created_at, error, attempts, payload").eq("type", "SYNC_TO_WOO").in("state", ["ready", "processing", "error"]).order("created_at", { ascending: false }).limit(50);
      return data?.find((job: any) => { const ids = (job.payload as any)?.productIds; return Array.isArray(ids) && ids.includes(id); }) || null;
    },
    enabled: !!id,
    refetchInterval: 10000,
  });

  const { data: aiContentForScore } = useQuery({
    queryKey: ["ai-content", id],
    queryFn: async () => {
      const { data } = await supabase.from("product_ai_content").select("*").eq("product_id", id!).maybeSingle();
      return data;
    },
    enabled: !!id,
  });

  const { data: allBrands } = useQuery({
    queryKey: ["brands"],
    queryFn: async () => {
      const { data } = await supabase.from("brands").select("id, name").order("name");
      return data;
    },
  });

  // ── Edit state ──
  const [editedFields, setEditedFields] = useState<Record<string, any>>({});
  const [pendingLockChanges, setPendingLockChanges] = useState<Record<string, boolean>>({});
  const [brandPopoverOpen, setBrandPopoverOpen] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");
  const [savedIndicator, setSavedIndicator] = useState(false);

  const edited = product ? { ...product, ...editedFields, product_prices: { ...product.product_prices, ...(editedFields.product_prices || {}) } } : null;
  const hasChanges = Object.keys(editedFields).length > 0 || Object.keys(pendingLockChanges).length > 0;
  const setField = (field: string, value: any) => setEditedFields((prev) => ({ ...prev, [field]: value }));
  const setPriceField = (field: string, value: any) => setEditedFields((prev) => ({ ...prev, product_prices: { ...(prev.product_prices || {}), [field]: value } }));

  // Locked fields
  const currentLockedFields: string[] = Array.isArray((product as any)?.locked_fields) ? (product as any).locked_fields : [];
  const fieldSources: Record<string, string> = (product as any)?.field_sources || {};
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
      if (field !== 'product_prices' && field !== 'product_type') {
        newLockedFields.add(field);
        newFieldSources[field] = 'manual';
      }
    }
    const updateFields: any = { locked_fields: Array.from(newLockedFields), field_sources: newFieldSources };
    const simpleFields = ['title', 'sku', 'tax_code', 'url_key', 'webshop_text', 'webshop_text_en', 'short_description', 'meta_title', 'meta_description', 'focus_keyword', 'product_type', 'brand_id', 'publication_status'];
    for (const f of simpleFields) {
      if (f in fieldsToSave) updateFields[f] = fieldsToSave[f];
    }
    const { error: pErr } = await supabase.from("products").update(updateFields).eq("id", product.id);
    if (pErr) { toast.error(`Opslaan mislukt: ${pErr.message}`); return; }
    if (fieldsToSave.product_prices) {
      const { error: prErr } = await supabase.from("product_prices").update({ regular: edited?.product_prices?.regular, list: edited?.product_prices?.list }).eq("product_id", product.id);
      if (prErr) { toast.error(`Prijs opslaan mislukt: ${prErr.message}`); return; }
    }
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 2000);
    queryClient.invalidateQueries({ queryKey: ["product-detail", id] });
    queryClient.invalidateQueries({ queryKey: ["products"] });
  }, [product, effectiveLockedFields, fieldSources, edited, id, queryClient]);

  // Trigger debounced save when editedFields change
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

  // ── Mutations ──
  const retryJobMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const { error } = await supabase.from("jobs").update({ state: "ready", attempts: 0, error: null, updated_at: new Date().toISOString() }).eq("id", jobId);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Sync-job opnieuw ingepland"); queryClient.invalidateQueries({ queryKey: ["pending-sync-job", id] }); },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishSuccess, setPublishSuccess] = useState(false);

  const pushToWooMutation = useMutation({
    mutationFn: async (scope: string = 'FULL') => {
      if (!product) throw new Error("Geen product");
      setPublishError(null);
      setPublishSuccess(false);
      const resp = await invokeEdgeFunction<any>("push-to-woocommerce", {
        body: {
          tenantId: product.tenant_id,
          productIds: [product.id],
          syncScope: scope,
        },
      });
      if (resp?.error) throw new Error(typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error));
      return resp;
      return resp;
    },
    onSuccess: () => {
      setPublishSuccess(true);
      toast.success("Product gepubliceerd naar WooCommerce");
      queryClient.invalidateQueries({ queryKey: ["woo-link", id] });
      queryClient.invalidateQueries({ queryKey: ["pending-sync-job", id] });
      queryClient.invalidateQueries({ queryKey: ["product-detail", id] });
      setTimeout(() => setPublishSuccess(false), 4000);
    },
    onError: (e: any) => {
      setPublishError(e.message || "Onbekende fout bij publicatie");
      toast.error(`Publicatie mislukt: ${e.message}`);
    },
  });

  // Variant update mutation
  const updateVariantMutation = useMutation({
    mutationFn: async ({ variantId, field, value }: { variantId: string; field: string; value: any }) => {
      const { error } = await supabase.from("variants").update({ [field]: value }).eq("id", variantId);
      if (error) throw error;
    },
    onSuccess: () => { setSavedIndicator(true); setTimeout(() => setSavedIndicator(false), 2000); queryClient.invalidateQueries({ queryKey: ["product-detail", id] }); },
    onError: (e: any) => toast.error(`Update mislukt: ${e.message}`),
  });

  const handleVariantUpdate = (variantId: string, field: string, value: any) => {
    updateVariantMutation.mutate({ variantId, field, value });
  };

  // ── Loading / not found ──
  if (isLoading) return <Layout><div className="flex items-center justify-center py-20"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div></Layout>;
  if (!product) return <Layout><div className="text-center py-20"><p className="text-muted-foreground">Product niet gevonden</p><Button variant="ghost" className="mt-4" onClick={() => navigate("/products")}><ArrowLeft className="h-4 w-4 mr-2" /> Terug</Button></div></Layout>;

  // ── Derived data ──
  const totalStock = product.variants?.reduce((sum: number, v: any) => sum + (v.stock_totals?.qty ?? 0), 0) ?? 0;
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const storageBaseUrl = `${supabaseUrl}/storage/v1/object/public/product-images/`;
  const images = Array.isArray(product.images)
    ? (product.images as string[]).map((img) => {
        if (typeof img !== 'string' || !img) return '';
        if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('data:')) return img;
        return `${storageBaseUrl}${img.replace(/^modis\/foto\//i, '')}`;
      }).filter(Boolean)
    : [];
  const variantCount = product.variants?.length ?? 0;
  const price = Number(product.product_prices?.regular || 0);
  const isVariable = (edited?.product_type || product.product_type) !== 'simple';
  const productTags = Array.isArray(product.tags) ? (product.tags as string[]) : [];
  const wooUrl = wooLink?.permalink || (product.url_key ? `https://www.example.com/${product.url_key}` : '');

  // ── Completeness for publish bar ──
  const publishFields = [
    { name: 'title', filled: !!product.title?.trim() },
    { name: 'short_description', filled: !!(product as any).short_description?.trim() },
    { name: 'webshop_text', filled: !!product.webshop_text?.trim() },
    { name: 'meta_title', filled: !!product.meta_title?.trim() },
    { name: 'meta_description', filled: !!product.meta_description?.trim() },
    { name: 'focus_keyword', filled: !!(product as any).focus_keyword?.trim() },
  ];
  const filledCount = publishFields.filter(f => f.filled).length;
  const missingFields = publishFields.filter(f => !f.filled);
  const variantsWithoutEan = isVariable ? (product.variants || []).filter((v: any) => v.active && (!v.ean || v.ean === '0' || v.ean === '')).length : 0;
  const pubStatus = (product as any).publication_status || 'concept';

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
              <img src={images[0]} alt={product.title} className="h-full w-full object-cover" onError={(e) => {
                const img = e.target as HTMLImageElement;
                const fn = img.src.split("/").pop() || "";
                if (!img.src.includes("modis/foto/") && !img.dataset.retried) { img.dataset.retried = "1"; img.src = img.src.replace(`/product-images/${fn}`, `/product-images/modis/foto/${fn}`); }
                else img.src = "/placeholder.svg";
              }} />
            ) : <ImageIcon className="h-8 w-8 text-muted-foreground/40" />}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold truncate">{product.title}</h1>
            <div className="flex items-center gap-3 mt-1.5 text-sm text-muted-foreground">
              <span className="font-mono">{product.sku}</span><span>•</span>
              <span>{product.brands?.name || "Geen merk"}</span><span>•</span>
              <span>€{price.toFixed(2)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {totalStock > 0 ? <span className="badge-success">● {totalStock} op voorraad</span> : <span className="badge-error">● Niet op voorraad</span>}
              <span className="badge-info">{variantCount} varianten</span>
              <Badge variant="outline" className="text-[11px]">{isVariable ? "Variable" : "Simple"}</Badge>
              {images.length > 0 ? <span className="badge-neutral">{images.length} afbeeldingen</span> : <span className="badge-warning">Geen afbeeldingen</span>}
              {product.is_promotion && <Badge className="bg-destructive text-destructive-foreground text-[11px]">Sale</Badge>}
              {productTags.map((t) => <Badge key={t} variant="outline" className="text-[11px]">{t}</Badge>)}
              <Badge variant={pubStatus === 'published' ? 'default' : pubStatus === 'ready' ? 'secondary' : 'outline'} className="text-[11px]">
                {pubStatus === 'published' ? '● Gepubliceerd' : pubStatus === 'ready' ? '● Klaar' : '● Concept'}
              </Badge>
              {savedIndicator && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Opgeslagen</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Product type toggle */}
            <Select value={edited?.product_type || "variable"} onValueChange={(v) => setField("product_type", v)}>
              <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="variable">Variable</SelectItem>
                <SelectItem value="simple">Simple</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => navigate("/products")}><ArrowLeft className="h-4 w-4 mr-1" /> Terug</Button>
          </div>
        </div>

        {/* WooCommerce Sync Status */}
        {wooLink === null && (
          <Alert className="border-warning/50 bg-warning/10">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertDescription className="flex items-center justify-between">
              <span className="text-sm">Dit product is <strong>nog niet gekoppeld aan WooCommerce</strong>.</span>
              <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                {pendingSyncJob && pendingSyncJob.state !== 'error' && (
                  <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-xs"><RefreshCw className="h-3 w-3 mr-1 animate-spin" />{pendingSyncJob.state === 'processing' ? 'Wordt verwerkt' : 'In wachtrij'}</Badge>
                )}
                <Button size="sm" onClick={() => pushToWooMutation.mutate('FULL')} disabled={pushToWooMutation.isPending || (!!pendingSyncJob && pendingSyncJob.state !== 'error')}>
                  <Send className="h-4 w-4 mr-1" />{pushToWooMutation.isPending ? "Bezig..." : "Nu pushen"}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {wooLink && (
          <Alert className="border-success/50 bg-success/10">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <AlertDescription className="flex items-center justify-between">
              <span className="text-sm">
                WooCommerce ID: {wooLink.woo_id} — <strong>{wooLink.status}</strong>
                {wooLink.last_pushed_at && <span className="text-muted-foreground ml-2">· {new Date(wooLink.last_pushed_at).toLocaleString("nl-NL")}</span>}
              </span>
              <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                {wooLink.permalink && <Button size="sm" variant="outline" asChild><a href={wooLink.permalink} target="_blank" rel="noopener noreferrer"><Eye className="h-3.5 w-3.5 mr-1" />Webshop</a></Button>}
                <Button size="sm" variant="outline" onClick={() => pushToWooMutation.mutate('FULL')} disabled={pushToWooMutation.isPending}>
                  <RefreshCw className="h-4 w-4 mr-1" />{pushToWooMutation.isPending ? "Bezig..." : "Opnieuw pushen"}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Pending job alert */}
        {pendingSyncJob && (
          <Alert className={pendingSyncJob.state === 'error' ? "border-destructive/50 bg-destructive/10" : "border-primary/50 bg-primary/10"}>
            {pendingSyncJob.state === 'error' ? <XCircle className="h-4 w-4 text-destructive" /> : <RefreshCw className="h-4 w-4 text-primary animate-spin" />}
            <AlertDescription className="flex items-center justify-between">
              <span className="text-sm">
                {pendingSyncJob.state === 'ready' && <>Sync-job staat <strong>klaar</strong></>}
                {pendingSyncJob.state === 'processing' && <>Sync-job wordt <strong>verwerkt</strong>…</>}
                {pendingSyncJob.state === 'error' && <>Sync mislukt na {pendingSyncJob.attempts} poging(en){pendingSyncJob.error && <span className="text-muted-foreground ml-1">— {pendingSyncJob.error.slice(0, 80)}</span>}</>}
              </span>
              {pendingSyncJob.state === 'error' && (
                <Button size="sm" variant="outline" onClick={() => retryJobMutation.mutate(pendingSyncJob.id)} disabled={retryJobMutation.isPending}>
                  <RefreshCw className="h-4 w-4 mr-1" />{retryJobMutation.isPending ? "Bezig..." : "Opnieuw"}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* ═══════ TABS ═══════ */}
        <Tabs defaultValue="content" className="space-y-4">
          <TabsList>
            <TabsTrigger value="content" className="flex items-center gap-1"><FileText className="h-3.5 w-3.5" /> Content</TabsTrigger>
            <TabsTrigger value="seo" className="flex items-center gap-1"><SearchIcon className="h-3.5 w-3.5" /> SEO</TabsTrigger>
            {isVariable && <TabsTrigger value="variants" className="flex items-center gap-1"><Layers className="h-3.5 w-3.5" /> Varianten ({variantCount})</TabsTrigger>}
            <TabsTrigger value="eigenschappen" className="flex items-center gap-1"><Package className="h-3.5 w-3.5" /> Eigenschappen</TabsTrigger>
            <TabsTrigger value="modis" className="flex items-center gap-1"><Database className="h-3.5 w-3.5" /> Modis data</TabsTrigger>
          </TabsList>

          {/* ── TAB 1: Content ── */}
          <TabsContent value="content" className="space-y-4">
            <Card className="card-elevated">
              <CardContent className="pt-6 space-y-4">
                <LockableField fieldName="title" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <Label className="text-xs text-muted-foreground">Paginatitel</Label>
                  <Input value={edited?.title || ""} onChange={(e) => setField("title", e.target.value)} />
                </LockableField>

                <LockableField fieldName="short_description" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <Label className="text-xs text-muted-foreground">Korte omschrijving</Label>
                  <Textarea rows={3} value={(edited as any)?.short_description || ""} onChange={(e) => setField("short_description", e.target.value)} placeholder="Korte samenvatting voor de productpagina" />
                </LockableField>

                <LockableField fieldName="webshop_text" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Lange omschrijving (NL)</Label>
                    <Button size="sm" variant="ghost" className="h-6 text-xs gap-1 text-primary"><Sparkles className="h-3 w-3" /> AI genereren</Button>
                  </div>
                  <Textarea rows={6} value={edited?.webshop_text || ""} onChange={(e) => setField("webshop_text", e.target.value)} placeholder="Volledige productomschrijving in het Nederlands" />
                </LockableField>

                <LockableField fieldName="webshop_text_en" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Lange omschrijving (EN)</Label>
                    <Button size="sm" variant="ghost" className="h-6 text-xs gap-1 text-primary"><Sparkles className="h-3 w-3" /> AI vertalen</Button>
                  </div>
                  <Textarea rows={4} value={edited?.webshop_text_en || ""} onChange={(e) => setField("webshop_text_en", e.target.value)} placeholder="Full product description in English" />
                </LockableField>

                {/* Simple product: inline stock & price (read-only) */}
                {!isVariable && (
                  <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/50">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Voorraad</Label>
                      <div className="flex items-center gap-2">
                        <Badge variant={totalStock > 0 ? "default" : "destructive"}>{totalStock}</Badge>
                        <span className="text-xs text-muted-foreground">uit Modis</span>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Prijs</Label>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">€{price.toFixed(2)}</span>
                        <span className="text-xs text-muted-foreground">uit Modis</span>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* AI Content */}
            <AiContentTab product={product} />
          </TabsContent>

          {/* ── TAB 2: SEO ── */}
          <TabsContent value="seo" className="space-y-4">
            <GooglePreview
              url={wooUrl}
              title={edited?.meta_title || product.meta_title || edited?.title || product.title || ''}
              description={edited?.meta_description || product.meta_description || ''}
            />
            <Card className="card-elevated">
              <CardContent className="pt-6 space-y-4">
                <LockableField fieldName="focus_keyword" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Focus keyword</Label>
                    <span className="text-[10px] text-muted-foreground">→ rank_math_focus_keyword</span>
                  </div>
                  <Input value={(edited as any)?.focus_keyword || ""} onChange={(e) => setField("focus_keyword", e.target.value)} placeholder="Bijv. zwarte laarzen dames" />
                </LockableField>

                <LockableField fieldName="meta_title" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Meta title</Label>
                    <CharCounter value={edited?.meta_title || ""} max={70} greenAbove={50} />
                  </div>
                  <Input maxLength={70} value={edited?.meta_title || ""} onChange={(e) => setField("meta_title", e.target.value)} placeholder="SEO titel (max 70 tekens)" />
                </LockableField>

                <LockableField fieldName="meta_description" lockedFields={effectiveLockedFields} fieldSources={fieldSources} onToggleLock={toggleLock}>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Meta description</Label>
                    <CharCounter value={edited?.meta_description || ""} max={160} greenAbove={120} />
                  </div>
                  <Textarea rows={3} maxLength={160} value={edited?.meta_description || ""} onChange={(e) => setField("meta_description", e.target.value)} placeholder="SEO beschrijving (max 160 tekens)" />
                </LockableField>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── TAB 3: Varianten & Voorraad ── */}
          {isVariable && (
            <TabsContent value="variants">
              <Card className="card-elevated">
                <CardHeader>
                  <CardTitle className="text-base flex items-center justify-between">
                    <span>Varianten & Voorraad</span>
                    <div className="flex items-center gap-2">
                      {(!product.variants || product.variants.length === 0) && (product.attributes as any)?.Maat && <CreateVariantsFromAttributes product={product} />}
                      <span className="badge-info">{totalStock} totaal</span>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {product.variants && product.variants.length > 0 ? (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border text-xs font-medium uppercase tracking-wider text-muted-foreground">
                              <th className="py-2 px-3 text-left">Maat</th>
                              <th className="py-2 px-3 text-left">Maat web</th>
                              <th className="py-2 px-3 text-left">EAN</th>
                              <th className="py-2 px-3 text-left">Variant SKU</th>
                              <th className="py-2 px-3 text-left">Voorraad</th>
                              <th className="py-2 px-3 text-left">Prijs</th>
                              <th className="py-2 px-3 text-left">Actief</th>
                              <th className="py-2 px-3 text-left">Backorder</th>
                            </tr>
                          </thead>
                          <tbody>
                            {product.variants.map((v: any) => (
                              <VariantRow key={v.id} variant={{ ...v, price: product.product_prices?.regular }} onUpdate={handleVariantUpdate} />
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" /> Maten, voorraad en prijs komen uit Modis en zijn niet bewerkbaar
                      </p>
                    </>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">Geen varianten</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── TAB 4: Eigenschappen ── */}
          <TabsContent value="eigenschappen" className="space-y-4">
            <ProductAttributesTab product={product} section="attributes" />
            <ProductAttributesTab product={product} section="categories" />

            {/* Color & Brand (read-only from Modis) */}
            {(product.color || product.brands) && (
              <Card className="card-elevated">
                <CardHeader><CardTitle className="text-base">Modis velden (read-only)</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-4 text-sm">
                  {product.brands?.name && (
                    <div><span className="text-muted-foreground">Merk:</span> <span className="font-medium ml-1">{product.brands.name}</span> <SourceBadge source="modis" /></div>
                  )}
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

          {/* ── TAB 5: Modis data ── */}
          <TabsContent value="modis">
            <Card className="card-elevated">
              <CardHeader><CardTitle className="text-base">Modis & Sync gegevens</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 lg:grid-cols-3 gap-y-3 gap-x-6 text-sm">
                <div><span className="text-muted-foreground">SKU:</span> <span className="font-mono ml-1">{product.sku}</span></div>
                <div><span className="text-muted-foreground">Artikelgroep:</span> <span className="ml-1">{(product.article_group as any)?.description || (product.article_group as any)?.id || '—'}</span></div>
                <div><span className="text-muted-foreground">Inkoopprijs:</span> <span className="ml-1">€{Number(product.cost_price || 0).toFixed(2)}</span></div>
                <div><span className="text-muted-foreground">Verkoopprijs:</span> <span className="ml-1">€{price.toFixed(2)}</span></div>
                <div><span className="text-muted-foreground">Sale prijs:</span> <span className="ml-1">€{Number(product.product_prices?.list || 0).toFixed(2)}</span></div>
                <div><span className="text-muted-foreground">Korting:</span> <span className="ml-1">{product.discount_percentage || 0}%</span></div>
                <div><span className="text-muted-foreground">Totale voorraad:</span> <Badge variant={totalStock > 0 ? "default" : "destructive"} className="ml-1">{totalStock}</Badge></div>
                <div><span className="text-muted-foreground">Laatste import:</span> <span className="ml-1">{new Date(product.updated_at).toLocaleString("nl-NL")}</span></div>
                <div><span className="text-muted-foreground">WooCommerce ID:</span> <span className="font-mono ml-1">{wooLink?.woo_id || (product as any).woocommerce_product_id || '—'}</span></div>
                <div><span className="text-muted-foreground">Laatste WC sync:</span> <span className="ml-1">{syncStatus?.last_synced_at ? new Date(syncStatus.last_synced_at).toLocaleString("nl-NL") : '—'}</span></div>
                <div><span className="text-muted-foreground">Sync count:</span> <span className="ml-1">{syncStatus?.sync_count || 0}</span></div>
                <div><span className="text-muted-foreground">Laatste error:</span> <span className="ml-1 text-destructive">{syncStatus?.last_error?.slice(0, 60) || '—'}</span></div>
                <div><span className="text-muted-foreground">Tax code:</span> <span className="ml-1">{product.tax_code || '—'}</span></div>
                <div><span className="text-muted-foreground">URL key:</span> <span className="font-mono ml-1">{product.url_key || '—'}</span></div>
                <div><span className="text-muted-foreground">Product type:</span> <span className="ml-1">{product.product_type}</span></div>

                {/* Dirty flags */}
                <div className="col-span-full pt-2 border-t border-border/50">
                  <span className="text-xs text-muted-foreground font-medium">Dirty flags:</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {['price_stock', 'content', 'taxonomy', 'media', 'variations'].map(scope => {
                      const dirty = (product as any)[`dirty_${scope}`];
                      return (
                        <Badge key={scope} variant={dirty ? "destructive" : "outline"} className="text-[10px]">
                          {scope}: {dirty ? 'dirty' : 'clean'}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* ═══════ PUBLICATION BAR ═══════ */}
        <Card className="card-elevated border-t-2 border-primary/20">
          <CardContent className="py-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium">{filledCount} van 6 velden ingevuld</span>
                  <Badge variant={pubStatus === 'published' ? 'default' : pubStatus === 'ready' ? 'secondary' : 'outline'} className="text-[11px]">
                    {pubStatus === 'published' ? 'Gepubliceerd' : pubStatus === 'ready' ? 'Klaar voor publicatie' : 'Concept'}
                  </Badge>
                </div>
                <Progress value={(filledCount / 6) * 100} className="h-1.5" />
              </div>
              <div className="flex items-center gap-2 ml-6">
                <Button size="sm" variant="outline" onClick={() => setField("publication_status", "ready")} disabled={pubStatus === 'ready' || pubStatus === 'published'}>
                  Markeer als klaar
                </Button>
                <Button size="sm" onClick={async () => {
                  setField("publication_status", "published");
                  if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                  await autoSave({ ...editedFields, publication_status: "published" });
                  setEditedFields({});
                  pushToWooMutation.mutate('FULL');
                }} disabled={filledCount < 4 || pushToWooMutation.isPending}>
                  <Send className="h-4 w-4 mr-1" />
                  {pushToWooMutation.isPending ? "Wordt gepubliceerd…" : publishSuccess ? "Gepubliceerd ✓" : "Publiceer in webshop"}
                </Button>
              </div>
            </div>
            {/* Missing fields */}
            {missingFields.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {missingFields.map(f => (
                  <span key={f.name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-amber-500/10 text-amber-700 border border-amber-200">
                    <AlertTriangle className="h-3 w-3" /> {f.name.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}
            {isVariable && variantsWithoutEan > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-amber-500/10 text-amber-700 border border-amber-200">
                <AlertTriangle className="h-3 w-3" /> {variantsWithoutEan} variant(en) zonder EAN
              </span>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
};

export default ProductDetail;
