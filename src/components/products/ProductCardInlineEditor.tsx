import { useState, useRef, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Plus, Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient, useQuery } from "@tanstack/react-query";

interface Props {
  product: any;
  onClose: () => void;
}

export const ProductCardInlineEditor = ({ product, onClose }: Props) => {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  // Categories
  const rawCats = Array.isArray(product.categories) ? product.categories : [];
  const [categories, setCategories] = useState<string[]>(
    rawCats.map((c: any) => (typeof c === "string" ? c : c?.name || ""))
  );
  const [newCat, setNewCat] = useState("");

  // Attributes
  const attrs = (product.attributes as Record<string, any>) || {};
  const [attributes, setAttributes] = useState<Record<string, string>>({ ...attrs });
  const [newAttrName, setNewAttrName] = useState("");

  // Fetch attribute definitions for suggestions
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

  const addCategory = () => {
    const val = newCat.trim();
    if (!val || categories.includes(val)) return;
    setCategories([...categories, val]);
    setNewCat("");
  };

  const removeCategory = (cat: string) => {
    setCategories(categories.filter(c => c !== cat));
  };

  const setAttr = (key: string, value: string) => {
    setAttributes(prev => ({ ...prev, [key]: value }));
  };

  const removeAttr = (key: string) => {
    setAttributes(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addAttribute = () => {
    if (!newAttrName || newAttrName in attributes) return;
    setAttributes(prev => ({ ...prev, [newAttrName]: "" }));
    setNewAttrName("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("products")
        .update({
          categories: categories,
          attributes: attributes,
        })
        .eq("id", product.id);

      if (error) throw error;
      toast.success("Product bijgewerkt");
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["validation-ids"] });
      onClose();
    } catch (err: any) {
      toast.error(`Fout: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Check for changes
  const catsSame = JSON.stringify(categories) === JSON.stringify(rawCats.map((c: any) => typeof c === "string" ? c : c?.name || ""));
  const attrsSame = JSON.stringify(attributes) === JSON.stringify(attrs);
  const hasChanges = !catsSame || !attrsSame;

  const unusedAttrDefs = attrDefs?.filter(d => !(d.name in attributes)) || [];

  return (
    <div
      className="border-t border-border pt-3 mt-2 space-y-3"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Categories */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Categorieën</p>
        <div className="flex flex-wrap gap-1">
          {categories.map(cat => (
            <Badge key={cat} variant="secondary" className="text-[10px] gap-0.5 pr-1">
              {cat}
              <button onClick={() => removeCategory(cat)} className="ml-0.5 hover:text-destructive">
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
          {categories.length === 0 && (
            <span className="text-[10px] text-muted-foreground italic">Geen categorieën</span>
          )}
        </div>
        <div className="flex gap-1">
          <Input
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            placeholder="Categorie toevoegen..."
            className="h-7 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCategory(); } }}
          />
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={addCategory} disabled={!newCat.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Attributes */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Attributen</p>
        <div className="space-y-1">
          {Object.entries(attributes).map(([key, val]) => {
            const def = attrDefs?.find(d => d.name === key);
            return (
              <div key={key} className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground w-20 shrink-0 truncate" title={key}>{key}</span>
                {def?.allowed_values && def.allowed_values.length > 0 ? (
                  <Select value={val || ""} onValueChange={(v) => setAttr(key, v)}>
                    <SelectTrigger className="h-6 text-[11px] flex-1 min-w-0">
                      <SelectValue placeholder="..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-48">
                      {def.allowed_values.map(v => (
                        <SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={val || ""}
                    onChange={(e) => setAttr(key, e.target.value)}
                    className="h-6 text-[11px] flex-1 min-w-0"
                  />
                )}
                <button onClick={() => removeAttr(key)} className="text-muted-foreground hover:text-destructive shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        {unusedAttrDefs.length > 0 && (
          <div className="flex gap-1">
            <Select value={newAttrName} onValueChange={setNewAttrName}>
              <SelectTrigger className="h-7 text-xs flex-1">
                <SelectValue placeholder="Attribuut toevoegen..." />
              </SelectTrigger>
              <SelectContent className="max-h-48">
                {unusedAttrDefs.map(d => (
                  <SelectItem key={d.name} value={d.name} className="text-xs">{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={addAttribute} disabled={!newAttrName}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>
          Annuleren
        </Button>
        <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
          Opslaan
        </Button>
      </div>
    </div>
  );
};
