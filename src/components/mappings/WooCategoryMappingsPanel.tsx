import { useState, useRef } from "react";
import { useCategoryMappings, WooCategoryMapping } from "@/hooks/useCategoryMappings";
import { TenantSelector } from "@/components/TenantSelector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Download, Upload, Search, ArrowRight, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function WooCategoryMappingsPanel() {
  const [tenantId, setTenantId] = useState("");
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { mappings, isLoading, upsertMapping, deleteMapping } = useCategoryMappings(tenantId || undefined);

  const filtered = mappings?.filter(
    (m) =>
      m.source_category.toLowerCase().includes(search.toLowerCase()) ||
      m.woo_category.toLowerCase().includes(search.toLowerCase())
  );

  const handleExport = () => {
    if (!mappings || mappings.length === 0) {
      toast.error("Geen mappings om te exporteren");
      return;
    }
    const exportData = mappings.map(({ source_category, woo_category }) => ({
      source_category,
      woo_category,
    }));
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `category-mappings-${tenantId || "all"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${exportData.length} mappings geëxporteerd`);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !tenantId) return;

    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as { source_category: string; woo_category: string }[];

      if (!Array.isArray(data)) throw new Error("JSON moet een array zijn");

      let count = 0;
      for (const item of data) {
        if (!item.source_category || !item.woo_category) continue;
        await upsertMapping.mutateAsync({
          source_category: item.source_category,
          woo_category: item.woo_category,
          tenant_id: tenantId,
        });
        count++;
      }
      toast.success(`${count} mappings geïmporteerd`);
    } catch (err: any) {
      toast.error(`Import mislukt: ${err.message}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">WooCommerce Categorie Mappings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <TenantSelector value={tenantId} onChange={setTenantId} />
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Zoek mapping..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExport} disabled={!mappings?.length}>
              <Download className="h-4 w-4 mr-2" />
              Export JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!tenantId || importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              Import JSON
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImport}
            />
          </div>
        </div>

        {/* Summary */}
        {mappings && (
          <div className="flex gap-2">
            <Badge variant="outline">{mappings.length} mappings</Badge>
            {!tenantId && (
              <Badge variant="secondary" className="text-xs">
                Selecteer een tenant om te importeren
              </Badge>
            )}
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Laden...</p>
        ) : !filtered || filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {tenantId ? "Geen mappings gevonden" : "Selecteer een tenant om mappings te bekijken"}
          </p>
        ) : (
          <div className="max-h-[500px] overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bron (Modis)</TableHead>
                  <TableHead className="w-10" />
                  <TableHead>Doel (WooCommerce)</TableHead>
                  <TableHead className="w-20">Acties</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-sm">{m.source_category}</TableCell>
                    <TableCell>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <Badge variant="default" className="text-xs">
                        {m.woo_category}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteMapping.mutate(m.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
