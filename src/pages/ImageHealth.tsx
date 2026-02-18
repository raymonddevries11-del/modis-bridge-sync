import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Zap,
  Image,
  ImageOff,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Search,
  HardDrive,
  BarChart3,
  ExternalLink,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "react-router-dom";

interface ProductImageStatus {
  id: string;
  sku: string;
  title: string;
  images: string[];
  status: "ok" | "missing" | "no_images";
  storageCount: number;
  externalCount: number;
  brokenCount: number;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1/object/public/product-images/`;

function classifyImages(images: unknown): {
  storageCount: number;
  externalCount: number;
  urls: string[];
} {
  if (!Array.isArray(images)) return { storageCount: 0, externalCount: 0, urls: [] };
  let storageCount = 0;
  let externalCount = 0;
  const urls: string[] = [];
  for (const img of images) {
    if (typeof img !== "string" || !img) continue;
    urls.push(img);
    if (img.includes("supabase.co/storage") || img.includes("product-images")) {
      storageCount++;
    } else {
      externalCount++;
    }
  }
  return { storageCount, externalCount, urls };
}

export default function ImageHealth() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "ok" | "missing" | "no_images">("all");
  const [isFixing, setIsFixing] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{
    productsFixed: number;
    urlsFixed: number;
    urlsNotFound: number;
    storageFilesIndexed: number;
  } | null>(null);

  // Fetch all products with images info
  const { data: products, isLoading, refetch } = useQuery({
    queryKey: ["image-health"],
    queryFn: async () => {
      // Fetch products in batches to avoid 1000 limit
      const all: ProductImageStatus[] = [];
      let offset = 0;
      const batchSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("products")
          .select("id, sku, title, images")
          .order("sku")
          .range(offset, offset + batchSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;

        for (const p of data) {
          const { storageCount, externalCount, urls } = classifyImages(p.images);
          const totalImages = urls.length;
          let status: ProductImageStatus["status"] = "ok";
          if (totalImages === 0) status = "no_images";
          else if (externalCount > 0) status = "missing";

          all.push({
            id: p.id,
            sku: p.sku,
            title: p.title,
            images: urls,
            status,
            storageCount,
            externalCount,
            brokenCount: 0,
          });
        }
        if (data.length < batchSize) break;
        offset += batchSize;
      }
      return all;
    },
    staleTime: 60_000,
  });

  // Fetch storage bucket stats
  const { data: bucketStats } = useQuery({
    queryKey: ["bucket-stats"],
    queryFn: async () => {
      let totalFiles = 0;
      let offset = 0;
      while (true) {
        const { data } = await supabase.storage
          .from("product-images")
          .list("", { limit: 1000, offset });
        if (!data || data.length === 0) break;
        totalFiles += data.length;
        if (data.length < 1000) break;
        offset += 1000;
      }
      return { totalFiles };
    },
    staleTime: 120_000,
  });

  // Fetch last auto-fix changelog entry
  const { data: lastFix } = useQuery({
    queryKey: ["last-image-fix"],
    queryFn: async () => {
      const { data } = await supabase
        .from("changelog")
        .select("*")
        .in("event_type", ["AUTO_IMAGE_FIX", "AUTO_IMAGE_FIX_NOOP", "BULK_IMAGE_REFRESH"])
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      return data;
    },
  });

  const handleManualFix = async () => {
    setIsFixing(true);
    try {
      const { data, error } = await supabase.functions.invoke("auto-fix-images", {
        body: { tenant: "kosterschoenmode", chunkSize: 200, maxChunks: 20, maxRetries: 3 },
      });
      if (error) throw error;
      toast({
        title: "Image fix voltooid",
        description: `${data?.totalFixed || 0} producten bijgewerkt, ${data?.totalConverted || 0} URLs geconverteerd`,
      });
      refetch();
    } catch (err) {
      toast({
        title: "Fout bij image fix",
        description: err instanceof Error ? err.message : "Onbekende fout",
        variant: "destructive",
      });
    } finally {
      setIsFixing(false);
    }
  };

  const handleReconcile = async () => {
    setIsReconciling(true);
    setReconcileResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("reconcile-images", {
        body: { tenant: "kosterschoenmode", dryRun: false },
      });
      if (error) throw error;
      setReconcileResult(data);
      toast({
        title: "Reconcile voltooid",
        description: `${data?.productsFixed || 0} producten bijgewerkt, ${data?.urlsFixed || 0} URLs gefixt, ${data?.urlsNotFound || 0} niet gevonden`,
      });
      refetch();
    } catch (err) {
      toast({
        title: "Fout bij reconcile",
        description: err instanceof Error ? err.message : "Onbekende fout",
        variant: "destructive",
      });
    } finally {
      setIsReconciling(false);
    }
  };

  // Compute stats
  const stats = products
    ? {
        total: products.length,
        ok: products.filter((p) => p.status === "ok").length,
        missing: products.filter((p) => p.status === "missing").length,
        noImages: products.filter((p) => p.status === "no_images").length,
        totalStorage: products.reduce((s, p) => s + p.storageCount, 0),
        totalExternal: products.reduce((s, p) => s + p.externalCount, 0),
      }
    : null;

  const healthPct = stats ? Math.round((stats.ok / Math.max(stats.total, 1)) * 100) : 0;

  // Filter & search
  const filtered = (products || []).filter((p) => {
    if (filterStatus !== "all" && p.status !== filterStatus) return false;
    if (search) {
      const q = search.toLowerCase();
      return p.sku.toLowerCase().includes(q) || p.title.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2">
              <Image className="h-6 w-6 text-primary" />
              Image Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Beschikbaarheid van afbeeldingen per product en storage status
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleReconcile} disabled={isReconciling} size="sm" variant="default">
              <Zap className={`h-4 w-4 mr-2 ${isReconciling ? "animate-spin" : ""}`} />
              {isReconciling ? "Reconciling…" : "Reconcile alle images"}
            </Button>
            <Button onClick={handleManualFix} disabled={isFixing} size="sm" variant="outline">
              <RefreshCw className={`h-4 w-4 mr-2 ${isFixing ? "animate-spin" : ""}`} />
              {isFixing ? "Fixing…" : "Auto-fix"}
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Health Score
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{isLoading ? "—" : `${healthPct}%`}</div>
              <Progress value={healthPct} className="mt-2 h-2" />
              <p className="text-xs text-muted-foreground mt-1">
                {stats?.ok || 0} van {stats?.total || 0} producten OK
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                Storage Images
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{stats?.totalStorage ?? "—"}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Correct verwijzend naar storage bucket
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" />
                Externe/Missende URLs
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{stats?.totalExternal ?? "—"}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats?.missing || 0} producten met externe URLs
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Storage Bucket
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {bucketStats?.totalFiles ?? "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Bestanden in product-images bucket
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Reconcile result */}
        {reconcileResult && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-4 text-sm">
                <Zap className="h-4 w-4 text-primary" />
                <span><strong>{reconcileResult.productsFixed}</strong> producten bijgewerkt</span>
                <span><strong>{reconcileResult.urlsFixed}</strong> URLs gefixt</span>
                <span><strong>{reconcileResult.urlsNotFound}</strong> niet gevonden</span>
                <span className="text-muted-foreground">({reconcileResult.storageFilesIndexed} bestanden geïndexeerd)</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Last auto-fix info */}
        {lastFix && (
          <Card className="bg-muted/30">
            <CardContent className="py-3 px-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Laatste auto-fix:</span>
                <span className="font-medium text-foreground">{lastFix.description}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {new Date(lastFix.created_at).toLocaleString("nl-NL")}
              </span>
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Zoek op SKU of titel…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex gap-1">
            {(
              [
                { key: "all", label: "Alle", count: stats?.total },
                { key: "ok", label: "OK", count: stats?.ok },
                { key: "missing", label: "Extern", count: stats?.missing },
                { key: "no_images", label: "Geen", count: stats?.noImages },
              ] as const
            ).map((f) => (
              <Button
                key={f.key}
                variant={filterStatus === f.key ? "default" : "outline"}
                size="sm"
                onClick={() => setFilterStatus(f.key)}
                className="text-xs"
              >
                {f.label}
                {f.count !== undefined && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                    {f.count}
                  </Badge>
                )}
              </Button>
            ))}
          </div>
        </div>

        {/* Product Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="w-[100px] text-center">Status</TableHead>
                  <TableHead className="w-[90px] text-center">Storage</TableHead>
                  <TableHead className="w-[90px] text-center">Extern</TableHead>
                  <TableHead className="w-[80px] text-center">Totaal</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                      Laden…
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                      Geen producten gevonden
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.slice(0, 200).map((p) => (
                    <TableRow key={p.id} className="table-row-clean">
                      <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                      <TableCell className="text-sm truncate max-w-[300px]">{p.title}</TableCell>
                      <TableCell className="text-center">
                        {p.status === "ok" && (
                          <span className="badge-success">
                            <CheckCircle2 className="h-3 w-3" /> OK
                          </span>
                        )}
                        {p.status === "missing" && (
                          <span className="badge-warning">
                            <AlertTriangle className="h-3 w-3" /> Extern
                          </span>
                        )}
                        {p.status === "no_images" && (
                          <span className="badge-error">
                            <XCircle className="h-3 w-3" /> Geen
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-center text-sm font-medium">
                        {p.storageCount}
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {p.externalCount > 0 ? (
                          <span className="text-warning font-medium">{p.externalCount}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center text-sm text-muted-foreground">
                        {p.images.length}
                      </TableCell>
                      <TableCell>
                        <Link to={`/products/${p.id}`}>
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            {filtered.length > 200 && (
              <div className="text-center py-3 text-xs text-muted-foreground border-t border-border">
                Toont 200 van {filtered.length} producten. Gebruik de zoekfunctie om te filteren.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
