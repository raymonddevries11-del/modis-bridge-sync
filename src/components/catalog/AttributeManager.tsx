import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronDown, ChevronRight, Search, Plus, Pencil, Trash2, X, Package, ExternalLink, Replace } from "lucide-react";
import { toast } from "sonner";
import { type AttributeDefinition, useAttributeDefinitions } from "@/hooks/useAttributeDefinitions";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

interface AttrUsage {
  name: string;
  values: Set<string>;
  count: number;
}

interface Props {
  usage: AttrUsage[] | undefined;
  isLoading: boolean;
}

export const AttributeManager = ({ usage, isLoading }: Props) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { definitions, upsert, remove, isUpsertPending, isDeletePending } = useAttributeDefinitions();

  const [search, setSearch] = useState("");
  const [openAttrs, setOpenAttrs] = useState<Set<string>>(new Set());

  // Dialog state for attribute edit/create
  const [editDef, setEditDef] = useState<AttributeDefinition | null>(null);
  const [isNewDialog, setIsNewDialog] = useState(false);
  const [dialogName, setDialogName] = useState("");
  const [dialogValues, setDialogValues] = useState<string[]>([]);
  const [newValue, setNewValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AttributeDefinition | null>(null);

  // Bulk action state
  const [bulkAction, setBulkAction] = useState<"rename" | "delete" | null>(null);
  const [bulkAttrName, setBulkAttrName] = useState("");
  const [bulkOldValue, setBulkOldValue] = useState("");
  const [bulkNewValue, setBulkNewValue] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);

  const toggleAttr = (name: string) => {
    setOpenAttrs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  // Merge definitions with usage data
  const mergedAttrs = (() => {
    const usageMap = new Map((usage ?? []).map((u) => [u.name, u]));
    const defMap = new Map(definitions.map((d) => [d.name, d]));
    const allNames = new Set([...defMap.keys(), ...usageMap.keys()]);
    return Array.from(allNames)
      .map((name) => ({
        name,
        def: defMap.get(name) ?? null,
        usage: usageMap.get(name) ?? null,
        productCount: usageMap.get(name)?.count ?? 0,
        definedValues: defMap.get(name)?.allowed_values ?? [],
        usedValues: usageMap.get(name)?.values ?? new Set<string>(),
        sortOrder: defMap.get(name)?.sort_order ?? 999,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  })();

  const filtered = mergedAttrs.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  const openEditDialog = (def: AttributeDefinition | null, name = "") => {
    setEditDef(def);
    setIsNewDialog(!def);
    setDialogName(def?.name ?? name);
    setDialogValues([...(def?.allowed_values ?? [])]);
    setNewValue("");
  };

  const addValueToDialog = () => {
    const v = newValue.trim();
    if (!v || dialogValues.includes(v)) return;
    setDialogValues((prev) => [...prev, v]);
    setNewValue("");
  };

  const removeValueFromDialog = (val: string) => {
    setDialogValues((prev) => prev.filter((v) => v !== val));
  };

  const handleSave = async () => {
    if (!dialogName.trim()) return;
    await upsert({
      id: editDef?.id,
      name: dialogName.trim(),
      allowed_values: dialogValues,
      sort_order: editDef?.sort_order,
    });
    toast.success(editDef ? "Attribuut bijgewerkt" : "Attribuut aangemaakt");
    setEditDef(null);
    setIsNewDialog(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await remove(deleteTarget.id);
    toast.success(`"${deleteTarget.name}" verwijderd`);
    setDeleteTarget(null);
  };

  const openBulkRename = (attrName: string, value: string) => {
    setBulkAction("rename");
    setBulkAttrName(attrName);
    setBulkOldValue(value);
    setBulkNewValue(value);
  };

  const openBulkDelete = (attrName: string, value: string) => {
    setBulkAction("delete");
    setBulkAttrName(attrName);
    setBulkOldValue(value);
    setBulkNewValue("");
  };

  const handleBulkAction = async () => {
    if (!bulkAction || !bulkAttrName || !bulkOldValue) return;
    if (bulkAction === "rename" && (!bulkNewValue.trim() || bulkNewValue.trim() === bulkOldValue)) {
      toast.error("Nieuwe waarde moet anders zijn dan de huidige");
      return;
    }

    setBulkLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await supabase.functions.invoke("bulk-update-attribute-values", {
        body: {
          action: bulkAction,
          attributeName: bulkAttrName,
          oldValue: bulkOldValue,
          newValue: bulkAction === "rename" ? bulkNewValue.trim() : undefined,
        },
      });

      if (resp.error) throw resp.error;
      const result = resp.data;

      toast.success(
        bulkAction === "rename"
          ? `"${bulkOldValue}" hernoemd naar "${bulkNewValue.trim()}" bij ${result.productsUpdated} producten`
          : `"${bulkOldValue}" verwijderd bij ${result.productsUpdated} producten`
      );

      // Refresh data
      queryClient.invalidateQueries({ queryKey: ["catalog-attributes"] });
      queryClient.invalidateQueries({ queryKey: ["attribute-definitions"] });
      setBulkAction(null);
    } catch (err: any) {
      toast.error(`Fout: ${err.message}`);
    } finally {
      setBulkLoading(false);
    }
  };

  const renderValueBadge = (attrName: string, val: string, variant: "secondary" | "outline", isUndefined = false) => (
    <div key={val} className="group/val inline-flex items-center gap-0.5">
      <Badge
        variant={variant}
        className={`text-xs font-normal cursor-pointer hover:bg-primary/10 transition-colors ${
          isUndefined ? "border-amber-300 text-amber-700" : ""
        }`}
        onClick={() => navigate(`/products?attr=${encodeURIComponent(attrName)}&attrVal=${encodeURIComponent(val)}`)}
      >
        {val}
        {isUndefined && <span className="ml-1 text-[9px]">⚠</span>}
      </Badge>
      <div className="hidden group-hover/val:inline-flex items-center gap-0.5 ml-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0 text-muted-foreground hover:text-primary"
          title="Hernoemen bij alle producten"
          onClick={(e) => { e.stopPropagation(); openBulkRename(attrName, val); }}
        >
          <Replace className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
          title="Verwijderen bij alle producten"
          onClick={(e) => { e.stopPropagation(); openBulkDelete(attrName, val); }}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Zoek attribuut..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={() => openEditDialog(null)}>
          <Plus className="h-4 w-4 mr-1" /> Nieuw attribuut
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Laden...</p>
      ) : (
        <div className="grid gap-2">
          {filtered.map((attr) => (
            <Collapsible
              key={attr.name}
              open={openAttrs.has(attr.name)}
              onOpenChange={() => toggleAttr(attr.name)}
            >
              <CollapsibleTrigger className="flex items-center gap-3 w-full px-4 py-3 bg-card border border-border rounded-lg hover:bg-muted/50 transition-colors text-left">
                {openAttrs.has(attr.name) ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                )}
                <span className="text-sm font-medium flex-1">{attr.name}</span>
                {!attr.def && (
                  <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">
                    Niet gedefinieerd
                  </Badge>
                )}
                <Badge variant="secondary" className="text-xs">
                  {attr.definedValues.length > 0 ? attr.definedValues.length : attr.usedValues.size} waarden
                </Badge>
                <Badge
                  variant="outline"
                  className="text-xs cursor-pointer hover:bg-primary/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/products?attr=${encodeURIComponent(attr.name)}`);
                  }}
                >
                  <Package className="h-3 w-3 mr-1" />
                  {attr.productCount} producten
                  <ExternalLink className="h-3 w-3 ml-1 opacity-50" />
                </Badge>
                <div className="flex items-center gap-1 ml-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => openEditDialog(attr.def, attr.name)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {attr.def && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(attr.def!)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-7 mt-1 mb-2 px-4 py-3 bg-muted/30 rounded-lg border border-border/50">
                  <p className="text-[10px] text-muted-foreground mb-2 italic">Hover over een waarde voor bulk-acties (hernoemen / verwijderen bij alle producten)</p>
                  {attr.definedValues.length > 0 && (
                    <div className="mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Gedefinieerde waarden</span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {attr.definedValues.map((val) => renderValueBadge(attr.name, val, "secondary"))}
                      </div>
                    </div>
                  )}
                  {attr.usedValues.size > 0 && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">In gebruik</span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {Array.from(attr.usedValues)
                          .sort((a, b) => a.localeCompare(b, "nl"))
                          .map((val) =>
                            renderValueBadge(
                              attr.name,
                              val,
                              "outline",
                              attr.definedValues.length > 0 && !attr.definedValues.includes(val)
                            )
                          )}
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      )}

      {/* Edit / Create Dialog */}
      <Dialog open={!!editDef || isNewDialog} onOpenChange={(open) => { if (!open) { setEditDef(null); setIsNewDialog(false); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editDef ? "Attribuut bewerken" : "Nieuw attribuut"}</DialogTitle>
            <DialogDescription>Beheer de naam en toegestane waarden van dit attribuut.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Naam</label>
              <Input
                value={dialogName}
                onChange={(e) => setDialogName(e.target.value)}
                placeholder="Attribuutnaam..."
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Waarden ({dialogValues.length})</label>
              <div className="flex flex-wrap gap-1.5 min-h-[40px] p-2 border border-border rounded-md bg-muted/20">
                {dialogValues.map((val) => (
                  <Badge key={val} variant="secondary" className="text-xs gap-1 pr-1">
                    {val}
                    <button onClick={() => removeValueFromDialog(val)} className="hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                <Input
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="Nieuwe waarde..."
                  className="h-8 text-sm"
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addValueToDialog(); } }}
                />
                <Button size="sm" variant="outline" className="h-8" onClick={addValueToDialog} disabled={!newValue.trim()}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Toevoegen
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditDef(null); setIsNewDialog(false); }}>Annuleren</Button>
            <Button onClick={handleSave} disabled={!dialogName.trim() || isUpsertPending}>
              {isUpsertPending ? "Opslaan..." : "Opslaan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete attribute confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Attribuut verwijderen?</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je "{deleteTarget?.name}" wilt verwijderen? Dit verwijdert alleen de definitie, niet de data op producten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeletePending}>
              {isDeletePending ? "Verwijderen..." : "Verwijderen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Rename Dialog */}
      <Dialog open={bulkAction === "rename"} onOpenChange={(open) => { if (!open) setBulkAction(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Waarde hernoemen bij alle producten</DialogTitle>
            <DialogDescription>
              Hernoem de waarde "{bulkOldValue}" van attribuut "{bulkAttrName}" bij alle producten die deze waarde hebben.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Huidige waarde</label>
              <Input value={bulkOldValue} disabled className="bg-muted/50" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Nieuwe waarde</label>
              <Input
                value={bulkNewValue}
                onChange={(e) => setBulkNewValue(e.target.value)}
                placeholder="Nieuwe waarde..."
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkAction(null)}>Annuleren</Button>
            <Button onClick={handleBulkAction} disabled={bulkLoading || !bulkNewValue.trim() || bulkNewValue.trim() === bulkOldValue}>
              {bulkLoading ? "Bezig..." : "Hernoemen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <AlertDialog open={bulkAction === "delete"} onOpenChange={(open) => { if (!open) setBulkAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Waarde verwijderen bij alle producten?</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je de waarde "{bulkOldValue}" van attribuut "{bulkAttrName}" wilt verwijderen bij alle producten?
              Dit kan niet ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkAction} disabled={bulkLoading}>
              {bulkLoading ? "Bezig..." : "Verwijderen bij alle producten"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
