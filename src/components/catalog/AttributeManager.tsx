import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
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
import { ChevronDown, ChevronRight, Search, Plus, Pencil, Trash2, X, Package, ExternalLink, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { type AttributeDefinition, useAttributeDefinitions } from "@/hooks/useAttributeDefinitions";

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
  const { definitions, upsert, remove, isUpsertPending, isDeletePending } = useAttributeDefinitions();

  const [search, setSearch] = useState("");
  const [openAttrs, setOpenAttrs] = useState<Set<string>>(new Set());

  // Dialog state
  const [editDef, setEditDef] = useState<AttributeDefinition | null>(null);
  const [isNewDialog, setIsNewDialog] = useState(false);
  const [dialogName, setDialogName] = useState("");
  const [dialogValues, setDialogValues] = useState<string[]>([]);
  const [newValue, setNewValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AttributeDefinition | null>(null);

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
                  {attr.definedValues.length > 0 && (
                    <div className="mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Gedefinieerde waarden</span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {attr.definedValues.map((val) => (
                          <Badge
                            key={val}
                            variant="secondary"
                            className="text-xs font-normal cursor-pointer hover:bg-primary/10 transition-colors"
                            onClick={() => navigate(`/products?attr=${encodeURIComponent(attr.name)}&attrVal=${encodeURIComponent(val)}`)}
                          >
                            {val}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {attr.usedValues.size > 0 && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">In gebruik</span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {Array.from(attr.usedValues)
                          .sort((a, b) => a.localeCompare(b, "nl"))
                          .map((val) => (
                            <Badge
                              key={val}
                              variant="outline"
                              className={`text-xs font-normal cursor-pointer hover:bg-primary/10 transition-colors ${
                                attr.definedValues.length > 0 && !attr.definedValues.includes(val)
                                  ? "border-amber-300 text-amber-700"
                                  : ""
                              }`}
                              onClick={() => navigate(`/products?attr=${encodeURIComponent(attr.name)}&attrVal=${encodeURIComponent(val)}`)}
                            >
                              {val}
                              {attr.definedValues.length > 0 && !attr.definedValues.includes(val) && (
                                <span className="ml-1 text-[9px]">⚠</span>
                              )}
                            </Badge>
                          ))}
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

      {/* Delete confirmation */}
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
    </div>
  );
};
