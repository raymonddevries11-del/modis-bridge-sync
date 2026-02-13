import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Search, Package, ExternalLink, Pencil, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

interface CategoryInfo {
  name: string;
  count: number;
}

interface Props {
  categories: CategoryInfo[] | undefined;
  isLoading: boolean;
}

export const CategoryManager = ({ categories, isLoading }: Props) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  // Rename state
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteFilterType, setDeleteFilterType] = useState<string>("all");
  const [deleteFilterValue, setDeleteFilterValue] = useState("");

  // Add category state
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addCategoryName, setAddCategoryName] = useState("");
  const [addFilterType, setAddFilterType] = useState<string>("all");
  const [addFilterValue, setAddFilterValue] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Fetch brands for filter
  const { data: brands } = useQuery({
    queryKey: ["brands-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("brands")
        .select("id, name")
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  const filtered = categories?.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const openRename = (name: string) => {
    setRenameTarget(name);
    setRenameValue(name);
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim() || renameValue.trim() === renameTarget) return;
    setRenameLoading(true);
    try {
      const resp = await supabase.functions.invoke("bulk-update-categories", {
        body: { action: "rename", oldValue: renameTarget, newValue: renameValue.trim() },
      });
      if (resp.error) throw resp.error;
      toast.success(`"${renameTarget}" hernoemd naar "${renameValue.trim()}" bij ${resp.data.productsUpdated} producten`);
      queryClient.invalidateQueries({ queryKey: ["catalog-categories"] });
      setRenameTarget(null);
    } catch (err: any) {
      toast.error(`Fout: ${err.message}`);
    } finally {
      setRenameLoading(false);
    }
  };

  const openDeleteDialog = (name: string) => {
    setDeleteTarget(name);
    setDeleteFilterType("all");
    setDeleteFilterValue("");
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const body: any = { action: "delete", oldValue: deleteTarget };
      if (deleteFilterType !== "all") {
        body.filterType = deleteFilterType;
        body.filterValue = deleteFilterValue.trim();
      }
      const resp = await supabase.functions.invoke("bulk-update-categories", { body });
      if (resp.error) throw resp.error;
      const scope = deleteFilterType === "all" ? "alle" : "gefilterde";
      toast.success(`"${deleteTarget}" verwijderd bij ${resp.data.productsUpdated} ${scope} producten`);
      queryClient.invalidateQueries({ queryKey: ["catalog-categories"] });
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(`Fout: ${err.message}`);
    } finally {
      setDeleteLoading(false);
    }
  };

  const openAddDialog = () => {
    setAddCategoryName("");
    setAddFilterType("all");
    setAddFilterValue("");
    setShowAddDialog(true);
  };

  const handleAddCategory = async () => {
    if (!addCategoryName.trim()) return;
    if ((addFilterType === "category" || addFilterType === "brand" || addFilterType === "search") && !addFilterValue.trim()) {
      toast.error("Vul een filterwaarde in");
      return;
    }
    setAddLoading(true);
    try {
      const resp = await supabase.functions.invoke("bulk-add-category", {
        body: {
          categoryName: addCategoryName.trim(),
          filterType: addFilterType,
          filterValue: addFilterType === "all" ? undefined : addFilterValue.trim(),
        },
      });
      if (resp.error) throw resp.error;
      const { productsUpdated, productsSkipped } = resp.data;
      toast.success(
        `"${addCategoryName.trim()}" toegevoegd aan ${productsUpdated} producten` +
        (productsSkipped > 0 ? ` (${productsSkipped} hadden deze al)` : "")
      );
      queryClient.invalidateQueries({ queryKey: ["catalog-categories"] });
      setShowAddDialog(false);
    } catch (err: any) {
      toast.error(`Fout: ${err.message}`);
    } finally {
      setAddLoading(false);
    }
  };

  const filterDescription = () => {
    switch (addFilterType) {
      case "all": return "Alle producten in de catalogus";
      case "category": return `Producten met categorie "${addFilterValue}"`;
      case "brand": return `Producten van merk "${brands?.find(b => b.id === addFilterValue)?.name ?? addFilterValue}"`;
      case "search": return `Producten die "${addFilterValue}" bevatten in titel of SKU`;
      default: return "";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Zoek categorie..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={openAddDialog}>
          <Plus className="h-4 w-4 mr-1" /> Categorie toewijzen
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Laden...</p>
      ) : (
        <div className="grid gap-1">
          {filtered?.map((cat) => (
            <div
              key={cat.name}
              className="flex items-center justify-between px-4 py-2.5 bg-card border border-border rounded-lg group hover:bg-muted/50 transition-colors"
            >
              <span
                className="text-sm flex-1 cursor-pointer"
                onClick={() => navigate(`/products?category=${encodeURIComponent(cat.name)}`)}
              >
                {cat.name}
              </span>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  <Package className="h-3 w-3 mr-1" />
                  {cat.count}
                </Badge>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    title="Hernoemen"
                    onClick={() => openRename(cat.name)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    title="Verwijderen"
                    onClick={() => openDeleteDialog(cat.name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <ExternalLink
                  className="h-3.5 w-3.5 text-muted-foreground/50 cursor-pointer"
                  onClick={() => navigate(`/products?category=${encodeURIComponent(cat.name)}`)}
                />
              </div>
            </div>
          ))}
          {filtered?.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">Geen categorieën gevonden</p>
          )}
        </div>
      )}

      {/* Add Category Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Categorie toewijzen aan producten</DialogTitle>
            <DialogDescription>
              Voeg een categorie toe aan meerdere producten tegelijk op basis van een filter.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Categorienaam</Label>
              <Input
                value={addCategoryName}
                onChange={(e) => setAddCategoryName(e.target.value)}
                placeholder="Bijv. Nieuwe Collectie..."
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <Label className="text-sm font-medium">Toewijzen aan</Label>
              <Select value={addFilterType} onValueChange={(v) => { setAddFilterType(v); setAddFilterValue(""); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle producten</SelectItem>
                  <SelectItem value="category">Producten met bestaande categorie</SelectItem>
                  <SelectItem value="brand">Producten van een merk</SelectItem>
                  <SelectItem value="search">Zoek op titel / SKU</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {addFilterType === "category" && (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Bestaande categorie</Label>
                <Select value={addFilterValue} onValueChange={setAddFilterValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Kies categorie..." />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {categories?.map((cat) => (
                      <SelectItem key={cat.name} value={cat.name}>
                        {cat.name} ({cat.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {addFilterType === "brand" && (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Merk</Label>
                <Select value={addFilterValue} onValueChange={setAddFilterValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Kies merk..." />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {brands?.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {addFilterType === "search" && (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Zoekterm</Label>
                <Input
                  value={addFilterValue}
                  onChange={(e) => setAddFilterValue(e.target.value)}
                  placeholder="Zoek op titel of SKU..."
                />
              </div>
            )}

            {addCategoryName.trim() && (
              <div className="p-3 rounded-lg bg-muted/50 border border-border/60">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">"{addCategoryName.trim()}"</span> wordt toegevoegd aan:{" "}
                  {filterDescription()}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>Annuleren</Button>
            <Button
              onClick={handleAddCategory}
              disabled={
                addLoading ||
                !addCategoryName.trim() ||
                ((addFilterType === "category" || addFilterType === "brand" || addFilterType === "search") && !addFilterValue.trim())
              }
            >
              {addLoading ? "Bezig..." : "Toewijzen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Categorie hernoemen</DialogTitle>
            <DialogDescription>
              Hernoem "{renameTarget}" bij alle producten die deze categorie hebben.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Huidige naam</label>
              <Input value={renameTarget ?? ""} disabled className="bg-muted/50" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Nieuwe naam</label>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Nieuwe naam..."
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Annuleren</Button>
            <Button
              onClick={handleRename}
              disabled={renameLoading || !renameValue.trim() || renameValue.trim() === renameTarget}
            >
              {renameLoading ? "Bezig..." : "Hernoemen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation with Filters */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Categorie verwijderen</DialogTitle>
            <DialogDescription>
              Verwijder "{deleteTarget}" bij producten. Kies optioneel een filter om het alleen bij specifieke producten te doen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Verwijderen bij</Label>
              <Select value={deleteFilterType} onValueChange={(v) => { setDeleteFilterType(v); setDeleteFilterValue(""); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle producten met deze categorie</SelectItem>
                  <SelectItem value="brand">Producten van een merk</SelectItem>
                  <SelectItem value="search">Zoek op titel / SKU</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {deleteFilterType === "brand" && (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Merk</Label>
                <Select value={deleteFilterValue} onValueChange={setDeleteFilterValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Kies merk..." />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {brands?.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {deleteFilterType === "search" && (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Zoekterm</Label>
                <Input
                  value={deleteFilterValue}
                  onChange={(e) => setDeleteFilterValue(e.target.value)}
                  placeholder="Zoek op titel of SKU..."
                />
              </div>
            )}

            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-destructive">"{deleteTarget}"</span> wordt verwijderd bij:{" "}
                {deleteFilterType === "all" && "alle producten die deze categorie hebben"}
                {deleteFilterType === "brand" && `producten van merk "${brands?.find(b => b.id === deleteFilterValue)?.name ?? "..."}"`}
                {deleteFilterType === "search" && `producten die "${deleteFilterValue}" bevatten in titel of SKU`}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Annuleren</Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={
                deleteLoading ||
                ((deleteFilterType === "brand" || deleteFilterType === "search") && !deleteFilterValue.trim())
              }
            >
              {deleteLoading ? "Bezig..." : "Verwijderen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
