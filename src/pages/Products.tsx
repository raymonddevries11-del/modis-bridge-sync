import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Layout } from "@/components/Layout";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TenantSelector } from "@/components/TenantSelector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { calculateCompleteness, scoreColor, scoreBg } from "@/lib/completeness";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from "@/components/ui/pagination";
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
import { useState, useEffect, useRef, useCallback } from "react";
import { Search, RefreshCw, Calendar, Image, Upload, FileSpreadsheet, AlertTriangle, Package, Tag, Sparkles, FilterX, X, MoreVertical, ChevronDown, Layers, CheckSquare, Square, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActionToolbar } from "@/components/products/BulkActionToolbar";
import { VariantAuditWidget } from "@/components/products/VariantAuditWidget";
import { ProductCardInlineEditor } from "@/components/products/ProductCardInlineEditor";

const VALIDATION_FILTERS: Record<string, { label: string; fn: (p: any) => boolean }> = {
  "missing-images": { label: "Geen afbeeldingen", fn: (p) => { const imgs = Array.isArray(p.images) ? p.images : []; return imgs.length === 0; } },
  "zero-price": { label: "Prijs = €0", fn: (p) => Number(p.product_prices?.regular || 0) === 0 },
  "no-description": { label: "Geen omschrijving", fn: (p) => !p.webshop_text?.trim() },
  "no-meta-title": { label: "Geen meta titel", fn: (p) => !p.meta_title?.trim() },
  "no-meta-description": { label: "Geen meta description", fn: (p) => !p.meta_description?.trim() },
  "no-brand": { label: "Geen merk", fn: (p) => !p.brands?.name },
  "no-variants": { label: "Geen varianten", fn: (p) => p.product_type !== "simple" && (!p.variants || p.variants.length === 0) },
  "no-stock": { label: "Geen voorraad", fn: (p) => !p.variants?.some((v: any) => v.stock_totals?.qty > 0) },
  "no-attributes": { label: "Weinig attributen", fn: (p) => { const a = p.attributes as Record<string, any> | null; return !a || Object.keys(a).length < 3; } },
  "no-categories": { label: "Geen categorieën", fn: (p) => !Array.isArray(p.categories) || p.categories.length === 0 },
  "missing-ean": { label: "Ontbrekende EAN", fn: (p) => p.variants?.length > 0 && !p.variants.every((v: any) => v.ean && v.ean !== "0" && v.ean !== "") },
  "not-in-woo": { label: "Niet in WooCommerce", fn: (p) => !p.woocommerce_product_id },
  "dirty-woo": { label: "Wacht op WooCommerce sync", fn: (p) => p.dirty_content || p.dirty_media || p.dirty_price_stock || p.dirty_taxonomy || p.dirty_variations },
};

const Products = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const stockInputRef = useRef<HTMLInputElement>(null);
  const tagCsvInputRef = useRef<HTMLInputElement>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [stockFilter, setStockFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [completenessFilter, setCompletenessFilter] = useState<string>("all");
  const [validationFilter, setValidationFilter] = useState<string>(searchParams.get("validation") || "all");
  const [attrFilter, setAttrFilter] = useState<string>(searchParams.get("attr") || "");
  const [attrValFilter, setAttrValFilter] = useState<string>(searchParams.get("attrVal") || "");
  const [categoryFilter, setCategoryFilter] = useState<string>(searchParams.get("category") || "");
  const [selectedTenant, setSelectedTenant] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  const navigate = useNavigate();
  const [isTagDialogOpen, setIsTagDialogOpen] = useState(false);
  const [tagName, setTagName] = useState("2025-assortiment");
  const [pendingTagFile, setPendingTagFile] = useState<File | null>(null);
  const queryClient = useQueryClient();
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [editingProductId, setEditingProductId] = useState<string | null>(null);

  const toggleSelect = useCallback((id: string) => {
    setSelectedProductIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

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

  // Fetch unique tags for filter — lightweight: only fetch tags column, paginated
  const { data: tags } = useQuery({
    queryKey: ["product-tags", selectedTenant],
    queryFn: async () => {
      if (!selectedTenant) return [];
      const allTags = new Set<string>();
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from("products")
          .select("tags")
          .eq("tenant_id", selectedTenant)
          .not("tags", "is", null)
          .range(offset, offset + 999);
        if (!data || data.length === 0) break;
        data.forEach((p: any) => {
          p.tags?.forEach((t: string) => allTags.add(t));
        });
        if (data.length < 1000) break;
        offset += 1000;
      }
      return Array.from(allTags).sort();
    },
    enabled: !!selectedTenant,
    staleTime: 5 * 60 * 1000, // cache for 5 min
  });

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, brandFilter, supplierFilter, stockFilter, tagFilter, completenessFilter, validationFilter, attrFilter, attrValFilter, categoryFilter, selectedTenant]);

  // Pre-fetch matching product IDs when validation/stock/completeness filters are active
  const { data: validationMatchIds } = useQuery({
    queryKey: ["validation-ids", selectedTenant, searchTerm, brandFilter, supplierFilter, tagFilter, stockFilter, completenessFilter, validationFilter, attrFilter, attrValFilter, categoryFilter],
    queryFn: async () => {
      if (!selectedTenant) return null;
      // Only run when we have client-side filters active
      const needsClientFilter = validationFilter !== "all" || stockFilter !== "all" || completenessFilter !== "all" || !!attrFilter || !!categoryFilter;
      if (!needsClientFilter) return null;

      const allProducts: any[] = [];
      let offset = 0;
      while (true) {
        let query = supabase
          .from("products")
          .select(`id, sku, title, images, webshop_text, meta_title, meta_description, brand_id, attributes, categories, is_promotion, product_type, woocommerce_product_id, dirty_content, dirty_media, dirty_price_stock, dirty_taxonomy, dirty_variations,
            brands(id, name),
            product_prices(regular),
            variants(id, size_label, ean, stock_totals(qty))
          `)
          .eq("tenant_id", selectedTenant);

        if (searchTerm) query = query.or(`sku.ilike.%${searchTerm}%,title.ilike.%${searchTerm}%`);
        if (brandFilter !== "all") query = query.eq("brand_id", brandFilter);
        if (supplierFilter !== "all") query = query.eq("supplier_id", supplierFilter);
        if (tagFilter !== "all") query = query.contains("tags", [tagFilter]);

        const { data } = await query.range(offset, offset + 999);
        if (!data || data.length === 0) break;
        allProducts.push(...data);
        if (data.length < 1000) break;
        offset += 1000;
      }

      // Apply client-side filters
      let filtered = allProducts;

      if (validationFilter !== "all") {
        const vf = VALIDATION_FILTERS[validationFilter];
        if (vf) filtered = filtered.filter(vf.fn);
      }
      if (stockFilter === "in_stock") {
        filtered = filtered.filter((p: any) => p.variants?.some((v: any) => v.stock_totals?.qty > 0));
      }
      if (stockFilter === "out_of_stock") {
        filtered = filtered.filter((p: any) => !p.variants?.some((v: any) => v.stock_totals?.qty > 0));
      }
      if (completenessFilter !== "all") {
        filtered = filtered.filter((p: any) => {
          const score = calculateCompleteness(p).score;
          if (completenessFilter === "high") return score >= 80;
          if (completenessFilter === "medium") return score >= 50 && score < 80;
          if (completenessFilter === "low") return score < 50;
          return true;
        });
      }
      if (attrFilter) {
        filtered = filtered.filter((p: any) => {
          const attrs = p.attributes as Record<string, any> | null;
          if (!attrs) return false;
          if (!attrs[attrFilter]) return false;
          if (attrValFilter) {
            const val = String(attrs[attrFilter]);
            return val.split(",").map((v: string) => v.trim()).includes(attrValFilter);
          }
          return true;
        });
      }
      if (categoryFilter) {
        filtered = filtered.filter((p: any) => {
          const cats = p.categories as any[];
          if (!Array.isArray(cats)) return false;
          return cats.some((c: any) => {
            const label = typeof c === "string" ? c : (c?.name || "");
            return label === categoryFilter || label.includes(categoryFilter);
          });
        });
      }

      return filtered.map((p: any) => p.id as string);
    },
    enabled: !!selectedTenant && (validationFilter !== "all" || stockFilter !== "all" || completenessFilter !== "all" || !!attrFilter || !!categoryFilter),
  });

  const hasClientFilter = validationFilter !== "all" || stockFilter !== "all" || completenessFilter !== "all" || !!attrFilter || !!categoryFilter;

  // Get total count for pagination
  const { data: totalCount } = useQuery({
    queryKey: ["products-count", searchTerm, brandFilter, supplierFilter, tagFilter, selectedTenant, validationMatchIds],
    queryFn: async () => {
      if (!selectedTenant) return 0;
      if (hasClientFilter && validationMatchIds) return validationMatchIds.length;

      let query = supabase
        .from("products")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", selectedTenant);

      if (searchTerm) {
        query = query.or(`sku.ilike.%${searchTerm}%,title.ilike.%${searchTerm}%`);
      }
      if (brandFilter !== "all") {
        query = query.eq("brand_id", brandFilter);
      }
      if (supplierFilter !== "all") {
        query = query.eq("supplier_id", supplierFilter);
      }
      if (tagFilter !== "all") {
        query = query.contains("tags", [tagFilter]);
      }

      const { count } = await query;
      return count || 0;
    },
    enabled: !!selectedTenant,
  });

  const totalPages = Math.ceil((totalCount || 0) / PAGE_SIZE);

  const { data: products, isLoading } = useQuery({
    queryKey: ["products", searchTerm, brandFilter, supplierFilter, stockFilter, tagFilter, selectedTenant, currentPage, validationMatchIds],
    queryFn: async () => {
      if (!selectedTenant) return [];
      
      const from = (currentPage - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      // When client-side filters are active, use pre-fetched IDs
      if (hasClientFilter && validationMatchIds) {
        if (validationMatchIds.length === 0) return [];
        const pageIds = validationMatchIds.slice(from, to + 1);
        if (pageIds.length === 0) return [];

        const { data } = await supabase
          .from("products")
          .select(`
            *,
            brands(id, name),
            suppliers(id, name),
            product_prices(*),
            variants(*, stock_totals(*))
          `)
          .in("id", pageIds)
          .order("updated_at", { ascending: false });

        return data || [];
      }

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
      if (tagFilter !== "all") {
        query = query.contains("tags", [tagFilter]);
      }

      const { data } = await query.range(from, to);
      return data || [];
    },
    enabled: !!selectedTenant && (!hasClientFilter || validationMatchIds !== undefined),
  });

  const toggleSelectAll = useCallback(() => {
    if (!products) return;
    const allIds = products.map((p: any) => p.id);
    const allSelected = allIds.length > 0 && allIds.every((id: string) => selectedProductIds.has(id));
    if (allSelected) {
      setSelectedProductIds(prev => {
        const next = new Set(prev);
        allIds.forEach((id: string) => next.delete(id));
        return next;
      });
    } else {
      setSelectedProductIds(prev => {
        const next = new Set(prev);
        allIds.forEach((id: string) => next.add(id));
        return next;
      });
    }
  }, [products, selectedProductIds]);

  const [selectingAll, setSelectingAll] = useState(false);

  const selectAllFiltered = useCallback(async () => {
    if (!selectedTenant) return;
    setSelectingAll(true);
    try {
      if (hasClientFilter && validationMatchIds) {
        setSelectedProductIds(new Set(validationMatchIds));
        setSelectingAll(false);
        return;
      }
      const allIds: string[] = [];
      let offset = 0;
      while (true) {
        let query = supabase
          .from("products")
          .select("id")
          .eq("tenant_id", selectedTenant)
          .order("updated_at", { ascending: false })
          .range(offset, offset + 999);
        if (searchTerm) query = query.or(`sku.ilike.%${searchTerm}%,title.ilike.%${searchTerm}%`);
        if (brandFilter !== "all") query = query.eq("brand_id", brandFilter);
        if (supplierFilter !== "all") query = query.eq("supplier_id", supplierFilter);
        if (tagFilter !== "all") query = query.contains("tags", [tagFilter]);
        const { data } = await query;
        if (!data || data.length === 0) break;
        for (const row of data) allIds.push(row.id);
        if (data.length < 1000) break;
        offset += 1000;
      }
      setSelectedProductIds(new Set(allIds));
    } catch {
      toast.error("Kon niet alle producten selecteren");
    } finally {
      setSelectingAll(false);
    }
  }, [selectedTenant, searchTerm, brandFilter, supplierFilter, tagFilter, hasClientFilter, validationMatchIds]);

  // Fetch AI titles for quick comparison
  const { data: aiTitlesMap } = useQuery({
    queryKey: ["ai-titles", selectedTenant],
    queryFn: async () => {
      if (!selectedTenant) return {};
      const map: Record<string, { title: string; status: string }> = {};
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from("product_ai_content")
          .select("product_id, ai_title, status")
          .eq("tenant_id", selectedTenant)
          .range(offset, offset + 999);
        if (!data || data.length === 0) break;
        data.forEach((row: any) => { map[row.product_id] = { title: row.ai_title, status: row.status }; });
        if (data.length < 1000) break;
        offset += 1000;
      }
      return map;
    },
    enabled: !!selectedTenant,
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

  const tagProducts = useMutation({
    mutationFn: async ({ file, tag }: { file: File; tag: string }) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('tag', tag);
      formData.append('tenantId', selectedTenant);

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tag-products-from-csv`,
        {
          method: 'POST',
          body: formData,
          headers: {
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to tag products');
      }

      return response.json();
    },
    onSuccess: (data) => {
      toast.success(`Tag "${data.tag}" toegevoegd aan ${data.updated} producten. ${data.notFoundCount} SKUs niet gevonden.`);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-tags"] });
      setIsTagDialogOpen(false);
      setPendingTagFile(null);
    },
    onError: (error: any) => {
      toast.error(`Taggen mislukt: ${error.message}`);
    },
  });

  const [aiProgress, setAiProgress] = useState<{ current: number; total: number; success: number; failed: number } | null>(null);

  const bulkGenerateAiContent = useMutation({
    mutationFn: async (mode: "all" | "tag") => {
      // Step 1: Get all product IDs that need AI content
      let allProductIds: string[] = [];
      let offset = 0;
      
      while (true) {
        let query = supabase
          .from("products")
          .select("id")
          .eq("tenant_id", selectedTenant);
        
        if (mode === "tag" && tagFilter !== "all") {
          query = query.contains("tags", [tagFilter]);
        }
        
        const { data, error } = await query.range(offset, offset + 999);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allProductIds.push(...data.map(p => p.id));
        if (data.length < 1000) break;
        offset += 1000;
      }

      if (allProductIds.length === 0) {
        throw new Error("Geen producten gevonden");
      }

      // Step 2: Get product IDs that already have AI content
      const existingIds = new Set<string>();
      let aiOffset = 0;
      while (true) {
        const { data } = await supabase
          .from("product_ai_content")
          .select("product_id")
          .eq("tenant_id", selectedTenant)
          .not("ai_title", "is", null)
          .range(aiOffset, aiOffset + 999);
        
        if (!data || data.length === 0) break;
        data.forEach(d => existingIds.add(d.product_id));
        if (data.length < 1000) break;
        aiOffset += 1000;
      }

      // Step 3: Filter to only products without AI content
      const productIds = allProductIds.filter(id => !existingIds.has(id));
      
      if (productIds.length === 0) {
        throw new Error("Alle producten hebben al AI-content");
      }

      toast.info(`${productIds.length} producten zonder AI-content gevonden. Generatie gestart...`);

      const batchSize = 10;
      let processed = 0;
      let successCount = 0;
      let failedCount = 0;

      setAiProgress({ current: 0, total: productIds.length, success: 0, failed: 0 });

      for (let i = 0; i < productIds.length; i += batchSize) {
        const batch = productIds.slice(i, i + batchSize);
        
        try {
          const { data, error } = await supabase.functions.invoke("generate-ai-content", {
            body: { productIds: batch, tenantId: selectedTenant },
          });

          if (error) {
            console.error("Batch error:", error);
            failedCount += batch.length;
          } else {
            successCount += data.success || 0;
            failedCount += data.failed || 0;
          }
        } catch (e) {
          console.error("Batch exception:", e);
          failedCount += batch.length;
        }

        processed += batch.length;
        setAiProgress({ current: processed, total: productIds.length, success: successCount, failed: failedCount });

        // Delay between batches to avoid rate limits
        if (i + batchSize < productIds.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      return { successCount, failedCount, total: productIds.length };
    },
    onSuccess: (data) => {
      toast.success(`AI content gegenereerd: ${data.successCount} succesvol, ${data.failedCount} mislukt van ${data.total} producten`);
      setAiProgress(null);
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: any) => {
      toast.error(`AI generatie mislukt: ${error.message}`);
      setAiProgress(null);
    },
  });

  const [resetJobId, setResetJobId] = useState<string | null>(null);
  const [resetProgress, setResetProgress] = useState<{ current: number; total: number; updated: number } | null>(null);

  const [bulkVariantProgress, setBulkVariantProgress] = useState<{ totalVariants: number; totalProducts: number; batches: number } | null>(null);

  const bulkCreateVariants = useMutation({
    mutationFn: async () => {
      let totalVariants = 0;
      let totalProducts = 0;
      let offset = 0;
      let batches = 0;

      while (true) {
        const { data, error } = await supabase.functions.invoke("bulk-create-variants", {
          body: { tenantId: selectedTenant, offset },
        });
        if (error) throw error;

        totalVariants += data.variantsCreated || 0;
        totalProducts += data.productsProcessed || 0;
        batches++;
        setBulkVariantProgress({ totalVariants, totalProducts, batches });

        if (data.complete || !data.hasMore) break;
        offset = data.nextOffset;
      }

      return { totalVariants, totalProducts };
    },
    onSuccess: (data) => {
      toast.success(`${data.totalVariants} varianten aangemaakt voor ${data.totalProducts} producten`);
      setBulkVariantProgress(null);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["validation-ids"] });
    },
    onError: (error: any) => {
      toast.error(`Bulk varianten aanmaken mislukt: ${error.message}`);
      setBulkVariantProgress(null);
    },
  });

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

  const handleTagCsvSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast.error('Alleen CSV bestanden zijn toegestaan');
      return;
    }

    setPendingTagFile(file);
    setIsTagDialogOpen(true);

    if (tagCsvInputRef.current) {
      tagCsvInputRef.current.value = '';
    }
  };

  const handleConfirmTag = () => {
    if (pendingTagFile && tagName.trim()) {
      tagProducts.mutate({ file: pendingTagFile, tag: tagName.trim() });
    }
  };

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
              Browse and manage your product catalog {totalCount != null && `(${totalCount} items${totalPages > 1 ? `, pagina ${currentPage}/${totalPages}` : ""})`}
            </p>
          </div>
        </div>

        {/* Row 1: Search & Filters */}
        <Card className="border shadow-sm">
          <CardContent className="py-3 px-4 space-y-3">
            {/* Search + Tenant */}
            <div className="flex items-center gap-3">
              <TenantSelector value={selectedTenant} onChange={setSelectedTenant} />
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Zoek op SKU of titel..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                />
              </div>
              {/* Active filter count + clear */}
              {(() => {
                const activeCount = [
                  brandFilter !== "all",
                  supplierFilter !== "all",
                  stockFilter !== "all",
                  tagFilter !== "all",
                  completenessFilter !== "all",
                  validationFilter !== "all",
                  !!attrFilter,
                  !!categoryFilter,
                ].filter(Boolean).length;
                return activeCount > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground"
                    onClick={() => {
                      setBrandFilter("all");
                      setSupplierFilter("all");
                      setStockFilter("all");
                      setTagFilter("all");
                      setCompletenessFilter("all");
                      setValidationFilter("all");
                      setAttrFilter("");
                      setAttrValFilter("");
                      setCategoryFilter("");
                      searchParams.delete("validation");
                      searchParams.delete("attr");
                      searchParams.delete("attrVal");
                      searchParams.delete("category");
                      setSearchParams(searchParams, { replace: true });
                    }}
                  >
                    <X className="h-3 w-3 mr-1" />
                    {activeCount} filter{activeCount > 1 ? "s" : ""} wissen
                  </Button>
                ) : null;
              })()}
            </div>

            {/* Filters row */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider mr-1">Filters</span>

              <Select value={brandFilter} onValueChange={setBrandFilter}>
                <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs">
                  <SelectValue placeholder="Merk" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle merken</SelectItem>
                  {brands?.map((brand) => (
                    <SelectItem key={brand.id} value={brand.id}>{brand.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={supplierFilter} onValueChange={setSupplierFilter}>
                <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs">
                  <SelectValue placeholder="Leverancier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle leveranciers</SelectItem>
                  {suppliers?.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>{supplier.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={stockFilter} onValueChange={setStockFilter}>
                <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
                  <SelectValue placeholder="Voorraad" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle voorraad</SelectItem>
                  <SelectItem value="in_stock">Op voorraad</SelectItem>
                  <SelectItem value="out_of_stock">Niet op voorraad</SelectItem>
                </SelectContent>
              </Select>

              <Select value={tagFilter} onValueChange={setTagFilter}>
                <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
                  <Tag className="h-3 w-3 mr-1" />
                  <SelectValue placeholder="Tag" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle tags</SelectItem>
                  {tags?.map((tag) => (
                    <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={completenessFilter} onValueChange={setCompletenessFilter}>
                <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs">
                  <SelectValue placeholder="Score" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle scores</SelectItem>
                  <SelectItem value="critical">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-destructive" />
                      Kritiek (0–49%)
                    </span>
                  </SelectItem>
                  <SelectItem value="warning">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-warning" />
                      Waarschuwing (50–79%)
                    </span>
                  </SelectItem>
                  <SelectItem value="complete">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-success" />
                      Compleet (80–100%)
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>

              <Select value={validationFilter} onValueChange={(v) => {
                setValidationFilter(v);
                if (v === "all") {
                  searchParams.delete("validation");
                } else {
                  searchParams.set("validation", v);
                }
                setSearchParams(searchParams, { replace: true });
              }}>
                <SelectTrigger className="h-8 w-auto min-w-[160px] text-xs">
                  <FilterX className="h-3 w-3 mr-1" />
                  <SelectValue placeholder="Validation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle issues</SelectItem>
                  {Object.entries(VALIDATION_FILTERS).map(([key, { label }]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Active catalog data filters */}
            {(attrFilter || categoryFilter) && (
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider mr-1">Catalogus filter</span>
                {attrFilter && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Layers className="h-3 w-3" />
                    {attrFilter}{attrValFilter ? `: ${attrValFilter}` : ""}
                    <button
                      onClick={() => {
                        setAttrFilter("");
                        setAttrValFilter("");
                        searchParams.delete("attr");
                        searchParams.delete("attrVal");
                        setSearchParams(searchParams, { replace: true });
                      }}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
                {categoryFilter && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Tag className="h-3 w-3" />
                    {categoryFilter}
                    <button
                      onClick={() => {
                        setCategoryFilter("");
                        searchParams.delete("category");
                        setSearchParams(searchParams, { replace: true });
                      }}
                      className="ml-1 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Row 2: Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Primary actions exposed */}

          <Button
            onClick={() => syncToWooCommerce.mutate()}
            disabled={syncToWooCommerce.isPending}
            variant="outline"
            size="sm"
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${syncToWooCommerce.isPending ? "animate-spin" : ""}`} />
            Sync Producten
          </Button>

          {aiProgress ? (
            <div className="flex items-center gap-3 bg-primary/10 rounded-md px-3 py-1.5 min-w-[280px]">
              <Sparkles className="h-4 w-4 animate-pulse text-primary" />
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span>AI generatie...</span>
                  <span className="font-medium">{aiProgress.current}/{aiProgress.total} ({aiProgress.success} ✓ {aiProgress.failed > 0 ? `${aiProgress.failed} ✗` : ''})</span>
                </div>
                <Progress value={(aiProgress.current / aiProgress.total) * 100} className="h-1.5" />
              </div>
            </div>
          ) : (
            <Button
              onClick={() => bulkGenerateAiContent.mutate(tagFilter !== "all" ? "tag" : "all")}
              disabled={bulkGenerateAiContent.isPending || !selectedTenant}
              size="sm"
            >
              <Sparkles className="h-4 w-4 mr-1.5" />
              {tagFilter !== "all" ? `AI (${tagFilter})` : "AI Genereren"}
            </Button>
          )}

          {/* Secondary actions in dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreVertical className="h-4 w-4 mr-1.5" />
                Meer acties
                <ChevronDown className="h-3 w-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 bg-popover">
              <DropdownMenuItem
                onClick={() => fileInputRef.current?.click()}
                disabled={updateMaatIds.isPending || !selectedTenant}
              >
                <Upload className="h-4 w-4 mr-2" />
                Update Maat IDs
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => csvInputRef.current?.click()}
                disabled={updateWooSkus.isPending || !selectedTenant}
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Update WooCommerce SKUs
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => stockInputRef.current?.click()}
                disabled={importStock.isPending || !selectedTenant}
              >
                <Package className="h-4 w-4 mr-2" />
                Import Voorraad XML
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => tagCsvInputRef.current?.click()}
                disabled={tagProducts.isPending || !selectedTenant}
              >
                <Tag className="h-4 w-4 mr-2" />
                Tag Producten (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => bulkCreateVariants.mutate()}
                disabled={bulkCreateVariants.isPending || !selectedTenant}
              >
                <Package className="h-4 w-4 mr-2" />
                Bulk Varianten Aanmaken
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => {
                  // Trigger the alert dialog by clicking the hidden trigger
                  const trigger = document.getElementById('reset-stock-trigger');
                  trigger?.click();
                }}
                disabled={resetWooStock.isPending || !selectedTenant}
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Reset WooCommerce Voorraad
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Hidden file inputs */}
          <input ref={fileInputRef} type="file" accept=".xml,.csv" onChange={handleFileUpload} className="hidden" />
          <input ref={csvInputRef} type="file" accept=".csv" onChange={handleCsvUpload} className="hidden" />
          <input ref={stockInputRef} type="file" accept=".xml" onChange={handleStockUpload} className="hidden" />
          <input ref={tagCsvInputRef} type="file" accept=".csv" onChange={handleTagCsvSelect} className="hidden" />

          {/* Reset progress bar */}
          {resetProgress && (
            <div className="flex items-center gap-3 bg-muted rounded-md px-3 py-1.5 min-w-[250px]">
              <RefreshCw className="h-4 w-4 animate-spin text-destructive" />
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span>Reset bezig...</span>
                  <span className="font-medium">{resetProgress.current}/{resetProgress.total}</span>
                </div>
                <Progress value={(resetProgress.current / resetProgress.total) * 100} className="h-1.5" />
                <p className="text-xs text-muted-foreground mt-0.5">{resetProgress.updated} variaties op 0</p>
              </div>
            </div>
          )}

          {/* Bulk variant creation progress */}
          {bulkVariantProgress && (
            <div className="flex items-center gap-3 bg-primary/10 rounded-md px-3 py-1.5 min-w-[280px]">
              <Package className="h-4 w-4 animate-pulse text-primary" />
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span>Varianten aanmaken...</span>
                  <span className="font-medium">Batch {bulkVariantProgress.batches}</span>
                </div>
                <p className="text-xs text-muted-foreground">{bulkVariantProgress.totalVariants} varianten voor {bulkVariantProgress.totalProducts} producten</p>
              </div>
            </div>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button id="reset-stock-trigger" className="hidden" />
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
        </div>

        {/* Tag Dialog */}
        <Dialog open={isTagDialogOpen} onOpenChange={setIsTagDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Producten taggen</DialogTitle>
              <DialogDescription>
                Geef een tagnaam op voor de producten in het geüploade CSV bestand.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="tagName">Tagnaam</Label>
                <Input
                  id="tagName"
                  value={tagName}
                  onChange={(e) => setTagName(e.target.value)}
                  placeholder="bijv. 2025-assortiment"
                />
              </div>
              {pendingTagFile && (
                <p className="text-sm text-muted-foreground">
                  Bestand: {pendingTagFile.name}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsTagDialogOpen(false)}>
                Annuleren
              </Button>
              <Button 
                onClick={handleConfirmTag} 
                disabled={!tagName.trim() || tagProducts.isPending}
              >
                {tagProducts.isPending ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Bezig...
                  </>
                ) : (
                  <>
                    <Tag className="h-4 w-4 mr-2" />
                    Tag Toekennen
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Variant Audit Widget */}
        {selectedTenant && (
          <VariantAuditWidget tenantId={selectedTenant} />
        )}

        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading products...</p>
          </div>
        ) : products && products.length > 0 ? (
          <>
          {/* Select all toggle */}
          <div className="flex items-center gap-2 mb-2">
            <Checkbox
              checked={products.length > 0 && products.every((p: any) => selectedProductIds.has(p.id))}
              onCheckedChange={toggleSelectAll}
              id="select-all"
            />
            <label htmlFor="select-all" className="text-xs text-muted-foreground cursor-pointer select-none">
              Selecteer alle {products.length} op deze pagina
            </label>
            {totalCount != null && totalCount > products.length && (
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={selectAllFiltered}
                disabled={selectingAll || selectedProductIds.size === totalCount}
              >
                {selectingAll ? "Laden..." : selectedProductIds.size === totalCount ? `Alle ${totalCount} geselecteerd` : `Selecteer alle ${totalCount} resultaten`}
              </Button>
            )}
            {selectedProductIds.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">({selectedProductIds.size} geselecteerd)</span>
                <Button
                  size="sm"
                  variant="link"
                  className="h-auto p-0 text-xs text-destructive"
                  onClick={() => setSelectedProductIds(new Set())}
                >
                  Deselecteer alles
                </Button>
              </>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {products.map((product: any) => {
              const { score, checks } = calculateCompleteness(product);
              const totalStock = product.variants?.reduce((s: number, v: any) => s + (v.stock_totals?.qty ?? 0), 0) ?? 0;
              const imgCount = Array.isArray(product.images) ? product.images.length : 0;
              return (
                <Card
                  key={product.id}
                  className={`card-interactive group relative ${selectedProductIds.has(product.id) ? "ring-2 ring-primary" : ""} ${editingProductId === product.id ? "ring-2 ring-accent" : "cursor-pointer"}`}
                  onClick={() => { if (editingProductId !== product.id) navigate(`/products/${product.id}`); }}
                >
                  {/* Edit button */}
                  <div
                    className="absolute top-3 right-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      title="Inline bewerken"
                      onClick={() => setEditingProductId(editingProductId === product.id ? null : product.id)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div
                    className="absolute top-3 left-3 z-10"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selectedProductIds.has(product.id)}
                      onCheckedChange={() => toggleSelect(product.id)}
                      className="bg-background"
                    />
                  </div>
                  <CardHeader className="pb-3 pl-10">
                    <div className="flex items-start gap-3">
                      <div className="h-12 w-12 rounded-lg border border-border bg-muted/50 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {imgCount > 0 ? (
                          <img src={(product.images as string[])[0]} alt="" className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).src = "/placeholder.svg"; }} />
                        ) : (
                          <Image className="h-5 w-5 text-muted-foreground/40" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        {(() => {
                          const ai = aiTitlesMap?.[product.id];
                          return ai?.title ? (
                            <>
                              <CardTitle className="text-sm font-medium truncate">{ai.title}</CardTitle>
                              <p className="text-[11px] text-muted-foreground truncate line-through">{product.title}</p>
                            </>
                          ) : (
                            <CardTitle className="text-sm font-medium truncate">{product.title}</CardTitle>
                          );
                        })()}
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs font-mono text-muted-foreground">{product.sku}</span>
                          {product.brands?.name && <Badge variant="outline" className="text-[10px] px-1.5 py-0">{product.brands.name}</Badge>}
                          {product.is_promotion && <Badge className="bg-destructive text-destructive-foreground text-[10px] px-1.5 py-0">Sale</Badge>}
                          {aiTitlesMap?.[product.id]?.status === "approved" && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-success/15 text-success">AI ✓</Badge>}
                          {aiTitlesMap?.[product.id]?.status === "generated" && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-warning/15 text-warning">AI</Badge>}
                        </div>
                      </div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className={`flex items-center justify-center h-10 w-10 rounded-full text-xs font-bold ${scoreBg(score)} ${scoreColor(score)} flex-shrink-0`}>
                              {score}%
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-[200px]">
                            <p className="font-medium mb-1">Completeness</p>
                            {checks.filter(c => !c.passed).map(c => (
                              <p key={c.label} className="text-xs text-destructive">✕ {c.label}</p>
                            ))}
                            {checks.every(c => c.passed) && <p className="text-xs text-success">✓ Alles compleet</p>}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${score >= 80 ? "bg-success" : score >= 50 ? "bg-warning" : "bg-destructive"}`}
                        style={{ width: `${score}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>€{Number(product.product_prices?.regular || 0).toFixed(2)}</span>
                      <span>{product.variants?.length || 0} var</span>
                      <span>{imgCount} img</span>
                      <span className={totalStock > 0 ? "text-success" : "text-destructive"}>{totalStock} stock</span>
                    </div>
                    {score < 100 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {checks.filter(c => !c.passed).slice(0, 3).map(c => (
                          <span key={c.label} className="badge-warning text-[10px]">{c.label}</span>
                        ))}
                        {checks.filter(c => !c.passed).length > 3 && (
                          <span className="badge-neutral text-[10px]">+{checks.filter(c => !c.passed).length - 3}</span>
                        )}
                      </div>
                     )}
                     {editingProductId === product.id && (
                       <ProductCardInlineEditor
                         product={product}
                         onClose={() => setEditingProductId(null)}
                       />
                     )}
                   </CardContent>
                 </Card>
              );
            })}
          </div>
          </>
        ) : (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">
                {searchTerm ? "No products found matching your search" : "No products found"}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                />
              </PaginationItem>

              {/* First page */}
              {currentPage > 3 && (
                <>
                  <PaginationItem>
                    <PaginationLink onClick={() => setCurrentPage(1)} className="cursor-pointer">1</PaginationLink>
                  </PaginationItem>
                  {currentPage > 4 && (
                    <PaginationItem><PaginationEllipsis /></PaginationItem>
                  )}
                </>
              )}

              {/* Pages around current */}
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const page = Math.max(1, Math.min(totalPages - 4, currentPage - 2)) + i;
                if (page < 1 || page > totalPages) return null;
                return (
                  <PaginationItem key={page}>
                    <PaginationLink
                      isActive={page === currentPage}
                      onClick={() => setCurrentPage(page)}
                      className="cursor-pointer"
                    >
                      {page}
                    </PaginationLink>
                  </PaginationItem>
                );
              })}

              {/* Last page */}
              {currentPage < totalPages - 2 && (
                <>
                  {currentPage < totalPages - 3 && (
                    <PaginationItem><PaginationEllipsis /></PaginationItem>
                  )}
                  <PaginationItem>
                    <PaginationLink onClick={() => setCurrentPage(totalPages)} className="cursor-pointer">{totalPages}</PaginationLink>
                  </PaginationItem>
                </>
              )}

              <PaginationItem>
                <PaginationNext
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        )}

        <BulkActionToolbar
          selectedIds={Array.from(selectedProductIds)}
          onClearSelection={() => setSelectedProductIds(new Set())}
        />
      </div>
    </Layout>
  );
};

export default Products;
