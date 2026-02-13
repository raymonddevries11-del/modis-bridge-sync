import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Search, Package, ExternalLink, Pencil, Trash2 } from "lucide-react";
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

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const resp = await supabase.functions.invoke("bulk-update-categories", {
        body: { action: "delete", oldValue: deleteTarget },
      });
      if (resp.error) throw resp.error;
      toast.success(`"${deleteTarget}" verwijderd bij ${resp.data.productsUpdated} producten`);
      queryClient.invalidateQueries({ queryKey: ["catalog-categories"] });
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(`Fout: ${err.message}`);
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Zoek categorie..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
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
                    onClick={() => setDeleteTarget(cat.name)}
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

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Categorie verwijderen?</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je "{deleteTarget}" wilt verwijderen bij alle producten?
              Dit kan niet ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading ? "Bezig..." : "Verwijderen bij alle producten"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
