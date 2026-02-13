import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Save, Plus, X, Tag, Settings2 } from "lucide-react";

const KNOWN_ATTRIBUTES = [
  "Gender", "Wijdte", "Sluiting", "Bovenmateriaal", "Voering", "Binnenzool",
  "Loopzool", "Hakhoogte", "Uitneembaar voetbed", "Waterdichtheid",
  "Wandelschoentype", "Zoolstijfheid", "Kuitwijdte", "Stretch",
  "Hallux Valgus", "Diabetici", "Reuma/Artrose", "Peesplaat/Hielspoor",
];

const KNOWN_ATTRIBUTE_VALUES: Record<string, string[]> = {
  Gender: ["Dames", "Heren", "Unisex", "Kinderen", "Meisjes", "Jongens"],
  Wijdte: ["NVT", "F", "G", "G.5", "H", "H.5", "K", "M"],
  Sluiting: ["NVT", "Instap", "Gesp", "Veter", "Rits", "Klittenband", "Veter met 1 Rits", "Veter met 2 Ritsen"],
  Bovenmateriaal: ["Leer", "Nubuck", "Suede", "Textiel", "Synthetisch", "Combimaterialen leer"],
  Voering: ["Leer", "Textiel", "Synthetisch", "Onge voerd"],
  Binnenzool: ["Leer", "Textiel", "Synthetisch"],
  Loopzool: ["Rubber", "Leer", "Synthetisch", "Overige"],
  Hakhoogte: ["NVT", "0-1 cm", "1-2 cm", "2-4 cm", "4-6 cm", "6+ cm"],
  "Uitneembaar voetbed": ["NVT", "Hele zool", "Halve zool", "Ja"],
  Waterdichtheid: ["NVT", "Waterafstotend", "Waterdicht", "GORE-TEX"],
  Wandelschoentype: ["NVT", "Licht wandelen", "Dagwandeling", "Bergtocht"],
  Zoolstijfheid: ["NVT", "Flex", "Half Flex", "Stijf"],
  Kuitwijdte: ["NVT", "Normaal", "Wijd", "Extra wijd", "XL", "XXL"],
  Stretch: ["NVT", "Ja", "Nee"],
  "Hallux Valgus": ["NVT", "Ja"],
  Diabetici: ["NVT", "Ja"],
  "Reuma/Artrose": ["NVT", "Ja"],
  "Peesplaat/Hielspoor": ["NVT", "Ja"],
};

interface ProductAttributesTabProps {
  product: any;
  section?: "attributes" | "categories";
}

export const ProductAttributesTab = ({ product, section = "attributes" }: ProductAttributesTabProps) => {
  const queryClient = useQueryClient();
  const attrs = (product.attributes as Record<string, any>) || {};
  const cats = Array.isArray(product.categories) ? (product.categories as string[]) : [];

  const [editedAttributes, setEditedAttributes] = useState<Record<string, string>>({ ...attrs });
  const [editedCategories, setEditedCategories] = useState<string[]>([...cats]);
  const [newAttrKey, setNewAttrKey] = useState("");
  const [newAttrValue, setNewAttrValue] = useState("");
  const [newCategory, setNewCategory] = useState("");

  const hasChanges =
    JSON.stringify(editedAttributes) !== JSON.stringify(attrs) ||
    JSON.stringify(editedCategories) !== JSON.stringify(cats);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("products")
        .update({
          attributes: editedAttributes,
          categories: editedCategories,
        })
        .eq("id", product.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Attributen & categorieën opgeslagen");
      queryClient.invalidateQueries({ queryKey: ["product-detail", product.id] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (e: any) => toast.error(`Opslaan mislukt: ${e.message}`),
  });

  const setAttr = (key: string, value: string) => {
    setEditedAttributes((prev) => ({ ...prev, [key]: value }));
  };

  const removeAttr = (key: string) => {
    setEditedAttributes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addAttribute = () => {
    const key = newAttrKey.trim();
    if (!key) return;
    setEditedAttributes((prev) => ({ ...prev, [key]: newAttrValue.trim() || "NVT" }));
    setNewAttrKey("");
    setNewAttrValue("");
  };

  const addCategory = () => {
    const cat = newCategory.trim();
    if (!cat || editedCategories.includes(cat)) return;
    setEditedCategories((prev) => [...prev, cat]);
    setNewCategory("");
  };

  const removeCategory = (cat: string) => {
    setEditedCategories((prev) => prev.filter((c) => c !== cat));
  };

  const unusedAttributes = KNOWN_ATTRIBUTES.filter((a) => !(a in editedAttributes));

  // Derived read-only attributes from related data
  const color = product.color as Record<string, any> | null;
  const variants = product.variants as any[] | null;
  const maatValues = variants && variants.length > 0
    ? [...new Set(variants.map((v: any) => v.size_label))].sort((a: string, b: string) => parseFloat(a) - parseFloat(b)).join(", ")
    : (attrs.Maat as string) || "";

  const derivedAttributes: { label: string; value: string }[] = [
    { label: "Merk", value: product.brands?.name || "—" },
    { label: "Kleur", value: color ? [color.label, color.filter].filter(Boolean).join(" / ") : "—" },
    { label: "Maat (EU)", value: maatValues || "—" },
  ];

  const attrHasChanges = JSON.stringify(editedAttributes) !== JSON.stringify(attrs);
  const catHasChanges = JSON.stringify(editedCategories) !== JSON.stringify(cats);
  const sectionHasChanges = section === "attributes" ? attrHasChanges : catHasChanges;

  return (
    <div className="space-y-6">
      {/* Save bar */}
      {sectionHasChanges && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-primary/5 border border-primary/20">
          <span className="text-sm text-muted-foreground">Je hebt onopgeslagen wijzigingen</span>
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            <Save className="h-4 w-4 mr-1" /> {saveMutation.isPending ? "Opslaan..." : "Opslaan"}
          </Button>
        </div>
      )}

      {section === "attributes" && (
        <Card className="card-elevated">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-muted-foreground" />
              Productattributen
              <Badge variant="secondary" className="ml-auto text-[11px]">
                {Object.keys(editedAttributes).length + derivedAttributes.length} attributen
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Derived (read-only) attributes */}
            {derivedAttributes.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-3 border-b border-border/60">
                {derivedAttributes.map(({ label, value }) => (
                  <div key={label} className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground w-40 flex-shrink-0">{label}</Label>
                    <Input className="h-8 text-sm flex-1 bg-muted/50" value={value} disabled />
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Object.entries(editedAttributes)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2 group">
                    <Label className="text-xs text-muted-foreground w-40 flex-shrink-0 truncate" title={key}>
                      {key}
                    </Label>
                    {KNOWN_ATTRIBUTE_VALUES[key] ? (
                      <Select value={String(value)} onValueChange={(v) => setAttr(key, v)}>
                        <SelectTrigger className="h-8 text-sm flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {KNOWN_ATTRIBUTE_VALUES[key].map((opt) => (
                            <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                          ))}
                          {!KNOWN_ATTRIBUTE_VALUES[key].includes(String(value)) && (
                            <SelectItem value={String(value)}>{String(value)}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        className="h-8 text-sm flex-1"
                        value={String(value)}
                        onChange={(e) => setAttr(key, e.target.value)}
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      onClick={() => removeAttr(key)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
            </div>

            <div className="flex items-end gap-2 pt-2 border-t border-border/60">
              {unusedAttributes.length > 0 ? (
                <div className="flex-1 space-y-1">
                  <Label className="text-xs text-muted-foreground">Attribuut toevoegen</Label>
                  <Select value={newAttrKey} onValueChange={(v) => setNewAttrKey(v)}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Kies attribuut..." />
                    </SelectTrigger>
                    <SelectContent>
                      {unusedAttributes.map((a) => (
                        <SelectItem key={a} value={a}>{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="flex-1 space-y-1">
                  <Label className="text-xs text-muted-foreground">Nieuw attribuut</Label>
                  <Input
                    className="h-8 text-sm"
                    placeholder="Attribuutnaam..."
                    value={newAttrKey}
                    onChange={(e) => setNewAttrKey(e.target.value)}
                  />
                </div>
              )}
              <div className="flex-1 space-y-1">
                <Label className="text-xs text-muted-foreground">Waarde</Label>
                {newAttrKey && KNOWN_ATTRIBUTE_VALUES[newAttrKey] ? (
                  <Select value={newAttrValue} onValueChange={setNewAttrValue}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Kies waarde..." />
                    </SelectTrigger>
                    <SelectContent>
                      {KNOWN_ATTRIBUTE_VALUES[newAttrKey].map((opt) => (
                        <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    className="h-8 text-sm"
                    placeholder="Waarde..."
                    value={newAttrValue}
                    onChange={(e) => setNewAttrValue(e.target.value)}
                  />
                )}
              </div>
              <Button size="sm" variant="outline" className="h-8" onClick={addAttribute} disabled={!newAttrKey.trim()}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Toevoegen
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {section === "categories" && (
        <Card className="card-elevated">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Tag className="h-4 w-4 text-muted-foreground" />
              Productcategorieën
              <Badge variant="secondary" className="ml-auto text-[11px]">
                {editedCategories.length} categorieën
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {editedCategories.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {editedCategories.map((cat) => (
                  <Badge key={cat} variant="secondary" className="pl-3 pr-1.5 py-1.5 text-sm gap-1.5">
                    {cat}
                    <button
                      onClick={() => removeCategory(cat)}
                      className="ml-1 rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Geen categorieën toegewezen</p>
            )}

            <div className="flex items-end gap-2 pt-2 border-t border-border/60">
              <div className="flex-1 space-y-1">
                <Label className="text-xs text-muted-foreground">Categorie toevoegen</Label>
                <Input
                  className="h-8 text-sm"
                  placeholder="Categorienaam..."
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCategory(); } }}
                />
              </div>
              <Button size="sm" variant="outline" className="h-8" onClick={addCategory} disabled={!newCategory.trim()}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Toevoegen
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
