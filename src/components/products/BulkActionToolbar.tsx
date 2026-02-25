import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Tag, Layers, X, Plus, Minus, Pencil, AlertTriangle, Sparkles, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient, useQuery } from "@tanstack/react-query";

interface Props {
  selectedIds: string[];
  onClearSelection: () => void;
}

type ActionType = "add_category" | "remove_category" | "set_attribute" | "add_tag" | "remove_tag" | "approve_ai" | "delete";

export const BulkActionToolbar = ({ selectedIds, onClearSelection }: Props) => {
  const queryClient = useQueryClient();
  const [dialogAction, setDialogAction] = useState<ActionType | null>(null);
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Form values
  const [categoryName, setCategoryName] = useState("");
  const [attributeName, setAttributeName] = useState("");
  const [attributeValue, setAttributeValue] = useState("");
  const [tagValue, setTagValue] = useState("");

  // Fetch attribute definitions for dropdown
  const { data: attrDefs } = useQuery({
    queryKey: ["attribute-definitions"],
    queryFn: async () => {
      const { data } = await supabase
        .from("attribute_definitions")
        .select("name, allowed_values")
        .order("sort_order");
      return data || [];
    },
  });

  // Fetch categories for autocomplete
  const { data: categories } = useQuery({
    queryKey: ["catalog-categories-list"],
    queryFn: async () => {
      const catSet = new Set<string>();
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from("products")
          .select("categories")
          .not("categories", "is", null)
          .range(offset, offset + 999);
        if (!data || data.length === 0) break;
        for (const p of data) {
          const cats = p.categories as any[];
          if (!Array.isArray(cats)) continue;
          for (const c of cats) {
            const label = typeof c === "string" ? c : c?.name || "";
            if (label) catSet.add(label);
          }
        }
        if (data.length < 1000) break;
        offset += 1000;
      }
      return Array.from(catSet).sort();
    },
  });

  const selectedAttrDef = attrDefs?.find(d => d.name === attributeName);

  const openDialog = (action: ActionType) => {
    setCategoryName("");
    setAttributeName("");
    setAttributeValue("");
    setTagValue("");
    setDialogAction(action);
  };

  const CONFIRM_THRESHOLD = dialogAction === "delete" ? 1 : 500;

  const handleExecuteClick = () => {
    if (selectedIds.length > CONFIRM_THRESHOLD) {
      setShowConfirm(true);
    } else {
      handleExecute();
    }
  };

  const handleExecute = async () => {
    setShowConfirm(false);
    if (!dialogAction) return;
    setLoading(true);
    try {
      // Special handling for approve_ai — direct DB update
      if (dialogAction === "approve_ai") {
        const BATCH = 200;
        let totalApproved = 0;
        for (let i = 0; i < selectedIds.length; i += BATCH) {
          const batch = selectedIds.slice(i, i + BATCH);
          const { data, error } = await supabase
            .from("product_ai_content")
            .update({ status: "approved" as const, approved_at: new Date().toISOString() })
            .in("product_id", batch)
            .eq("status", "generated")
            .select("id");
          if (error) throw error;
          totalApproved += data?.length || 0;
        }
        toast.success(`${totalApproved} AI-content items goedgekeurd`);
        queryClient.invalidateQueries({ queryKey: ["products"] });
        queryClient.invalidateQueries({ queryKey: ["ai-content"] });
        setDialogAction(null);
        onClearSelection();
        return;
      }

      // Special handling for delete — direct DB delete
      if (dialogAction === "delete") {
        const BATCH = 200;
        let totalDeleted = 0;
        for (let i = 0; i < selectedIds.length; i += BATCH) {
          const batch = selectedIds.slice(i, i + BATCH);
          // Delete related data first
          await supabase.from("product_ai_content").delete().in("product_id", batch);
          await supabase.from("product_prices").delete().in("product_id", batch);
          await supabase.from("product_sync_status").delete().in("product_id", batch);
          await supabase.from("image_sync_status").delete().in("product_id", batch);
          // Delete variants (and their stock)
          const { data: variantIds } = await supabase
            .from("variants")
            .select("id")
            .in("product_id", batch);
          if (variantIds && variantIds.length > 0) {
            const vIds = variantIds.map(v => v.id);
            await supabase.from("stock_totals").delete().in("variant_id", vIds);
            await supabase.from("stock_by_store").delete().in("variant_id", vIds);
            await supabase.from("variants").delete().in("product_id", batch);
          }
          // Delete woo_products linked to these products
          await supabase.from("woo_products").delete().in("product_id", batch);
          // Delete the products themselves
          const { error, count } = await supabase
            .from("products")
            .delete({ count: "exact" })
            .in("id", batch);
          if (error) throw error;
          totalDeleted += count || 0;
        }
        toast.success(`${totalDeleted} producten verwijderd`);
        queryClient.invalidateQueries({ queryKey: ["products"] });
        queryClient.invalidateQueries({ queryKey: ["validation-ids"] });
        setDialogAction(null);
        onClearSelection();
        return;
      }

      let payload: Record<string, string> = {};
      switch (dialogAction) {
        case "add_category":
        case "remove_category":
          if (!categoryName.trim()) { toast.error("Vul een categorienaam in"); return; }
          payload = { categoryName: categoryName.trim() };
          break;
        case "set_attribute":
          if (!attributeName) { toast.error("Kies een attribuut"); return; }
          payload = { attributeName, attributeValue: attributeValue.trim() };
          break;
        case "add_tag":
        case "remove_tag":
          if (!tagValue.trim()) { toast.error("Vul een tag in"); return; }
          payload = { tag: tagValue.trim() };
          break;
      }

      const { data, error } = await supabase.functions.invoke("bulk-edit-products", {
        body: { productIds: selectedIds, action: dialogAction, payload },
      });
      if (error) throw error;

      const labels: Record<string, string> = {
        add_category: "Categorie toegevoegd",
        remove_category: "Categorie verwijderd",
        set_attribute: "Attribuut ingesteld",
        add_tag: "Tag toegevoegd",
        remove_tag: "Tag verwijderd",
      };
      toast.success(`${labels[dialogAction]} bij ${data.updated} producten${data.skipped > 0 ? ` (${data.skipped} overgeslagen)` : ""}`);

      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["validation-ids"] });
      queryClient.invalidateQueries({ queryKey: ["catalog-categories"] });
      queryClient.invalidateQueries({ queryKey: ["product-tags"] });
      setDialogAction(null);
      onClearSelection();
    } catch (err: any) {
      toast.error(`Fout: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (selectedIds.length === 0) return null;

  return (
    <>
      {/* Floating toolbar */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-card border border-border shadow-xl rounded-xl px-4 py-3 animate-in slide-in-from-bottom-4">
        <Badge variant="secondary" className="text-sm font-medium mr-1">
          {selectedIds.length} geselecteerd
        </Badge>

        <Button size="sm" variant="outline" onClick={() => openDialog("add_category")}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Categorie
        </Button>
        <Button size="sm" variant="outline" onClick={() => openDialog("remove_category")}>
          <Minus className="h-3.5 w-3.5 mr-1" /> Categorie
        </Button>
        <Button size="sm" variant="outline" onClick={() => openDialog("set_attribute")}>
          <Pencil className="h-3.5 w-3.5 mr-1" /> Attribuut
        </Button>
        <Button size="sm" variant="outline" onClick={() => openDialog("add_tag")}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Tag
        </Button>
        <Button size="sm" variant="outline" onClick={() => openDialog("remove_tag")}>
          <Minus className="h-3.5 w-3.5 mr-1" /> Tag
        </Button>
        <Button size="sm" variant="outline" onClick={() => openDialog("approve_ai")} className="border-emerald-300 text-emerald-600 hover:bg-emerald-50">
          <Check className="h-3.5 w-3.5 mr-1" /> AI Goedkeuren
        </Button>
        <Button size="sm" variant="destructive" onClick={() => openDialog("delete")}>
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Verwijderen
        </Button>

        <Button size="sm" variant="ghost" onClick={onClearSelection} className="ml-2">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Action dialog */}
      <Dialog open={!!dialogAction} onOpenChange={(open) => { if (!open) setDialogAction(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogAction === "add_category" && "Categorie toevoegen"}
              {dialogAction === "remove_category" && "Categorie verwijderen"}
              {dialogAction === "set_attribute" && "Attribuut instellen"}
              {dialogAction === "add_tag" && "Tag toevoegen"}
              {dialogAction === "remove_tag" && "Tag verwijderen"}
              {dialogAction === "approve_ai" && "AI Content goedkeuren"}
              {dialogAction === "delete" && "Producten verwijderen"}
            </DialogTitle>
            <DialogDescription>
              Pas toe op {selectedIds.length} geselecteerde producten.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {(dialogAction === "add_category" || dialogAction === "remove_category") && (
              <div className="space-y-2">
                <Label>Categorienaam</Label>
                {dialogAction === "remove_category" && categories && categories.length > 0 ? (
                  <Select value={categoryName} onValueChange={setCategoryName}>
                    <SelectTrigger>
                      <SelectValue placeholder="Kies categorie..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {categories.map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={categoryName}
                    onChange={(e) => setCategoryName(e.target.value)}
                    placeholder="Bijv. Nieuwe Collectie"
                    autoFocus
                  />
                )}
              </div>
            )}

            {dialogAction === "set_attribute" && (
              <>
                <div className="space-y-2">
                  <Label>Attribuut</Label>
                  <Select value={attributeName} onValueChange={(v) => { setAttributeName(v); setAttributeValue(""); }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Kies attribuut..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {attrDefs?.map(d => (
                        <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {attributeName && (
                  <div className="space-y-2">
                    <Label>Waarde</Label>
                    {selectedAttrDef?.allowed_values && selectedAttrDef.allowed_values.length > 0 ? (
                      <Select value={attributeValue} onValueChange={setAttributeValue}>
                        <SelectTrigger>
                          <SelectValue placeholder="Kies waarde..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-60">
                          {selectedAttrDef.allowed_values.map(v => (
                            <SelectItem key={v} value={v}>{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={attributeValue}
                        onChange={(e) => setAttributeValue(e.target.value)}
                        placeholder="Nieuwe waarde..."
                      />
                    )}
                  </div>
                )}
              </>
            )}

            {(dialogAction === "add_tag" || dialogAction === "remove_tag") && (
              <div className="space-y-2">
                <Label>Tag</Label>
                <Input
                  value={tagValue}
                  onChange={(e) => setTagValue(e.target.value)}
                  placeholder="Bijv. sale-2025"
                  autoFocus
                />
              </div>
            )}

            {dialogAction === "approve_ai" && (
              <p className="text-sm text-muted-foreground">
                Alle AI-content met status <strong>"generated"</strong> voor de {selectedIds.length} geselecteerde producten wordt goedgekeurd. Alleen gegenereerde content wordt aangepast — producten zonder AI-content worden overgeslagen.
              </p>
            )}

            {dialogAction === "delete" && (
              <div className="space-y-2">
                <p className="text-sm text-destructive font-medium">
                  ⚠️ Let op: dit verwijdert {selectedIds.length} producten permanent, inclusief varianten, voorraad, prijzen, sync-status en AI-content.
                </p>
                <p className="text-sm text-muted-foreground">
                  Deze actie kan niet ongedaan worden gemaakt.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogAction(null)}>Annuleren</Button>
            <Button
              onClick={handleExecuteClick}
              disabled={loading}
              variant={dialogAction === "remove_category" || dialogAction === "remove_tag" || dialogAction === "delete" ? "destructive" : "default"}
            >
              {loading ? "Bezig..." : "Toepassen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation for large bulk actions */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Weet je het zeker?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Je staat op het punt een bulk actie uit te voeren op <strong>{selectedIds.length}</strong> producten. Dit kan niet ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={handleExecute}>
              Ja, doorgaan met {selectedIds.length} producten
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
