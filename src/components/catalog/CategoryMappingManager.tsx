import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, ArrowRight, Check, X, AlertTriangle } from "lucide-react";
import { useCategoryMappings } from "@/hooks/useCategoryMappings";

interface CategoryInfo {
  name: string;
  count: number;
}

interface Props {
  categories: CategoryInfo[] | undefined;
  isLoading: boolean;
  tenantId: string;
}

export const CategoryMappingManager = ({ categories, isLoading, tenantId }: Props) => {
  const { mappings, isLoading: mappingsLoading, upsertMapping, deleteMapping } = useCategoryMappings(tenantId);
  const [search, setSearch] = useState("");
  const [editingSource, setEditingSource] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const mappingMap = new Map(mappings?.map((m) => [m.source_category, m]) || []);

  const filtered = categories?.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const unmappedCount = categories?.filter((c) => !mappingMap.has(c.name)).length ?? 0;

  const startEdit = (sourceCat: string) => {
    setEditingSource(sourceCat);
    setEditValue(mappingMap.get(sourceCat)?.woo_category || "");
  };

  const saveEdit = () => {
    if (!editingSource || !editValue.trim()) return;
    upsertMapping.mutate({
      source_category: editingSource,
      woo_category: editValue.trim(),
      tenant_id: tenantId,
    });
    setEditingSource(null);
  };

  const removeMapping = (sourceCat: string) => {
    const mapping = mappingMap.get(sourceCat);
    if (mapping) deleteMapping.mutate(mapping.id);
  };

  if (isLoading || mappingsLoading) {
    return <p className="text-sm text-muted-foreground">Laden...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Zoek broncategorie..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {unmappedCount > 0 && (
          <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
            <AlertTriangle className="h-3 w-3 mr-1" />
            {unmappedCount} ongemapped
          </Badge>
        )}
      </div>

      <div className="grid gap-1">
        {filtered?.map((cat) => {
          const mapping = mappingMap.get(cat.name);
          const isEditing = editingSource === cat.name;

          return (
            <div
              key={cat.name}
              className="flex items-center gap-3 px-4 py-2.5 bg-card border border-border rounded-lg group hover:bg-muted/50 transition-colors"
            >
              {/* Source category */}
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-sm truncate">{cat.name}</span>
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  {cat.count}
                </Badge>
              </div>

              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />

              {/* WooCommerce target */}
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {isEditing ? (
                  <div className="flex items-center gap-1 flex-1">
                    <Input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder="WooCommerce categorie..."
                      className="h-8 text-sm"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") setEditingSource(null);
                      }}
                    />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={saveEdit}>
                      <Check className="h-3.5 w-3.5 text-green-600" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditingSource(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : mapping ? (
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Badge variant="default" className="text-xs truncate max-w-[200px]">
                      {mapping.woo_category}
                    </Badge>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => startEdit(cat.name)}
                      >
                        Wijzig
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeMapping(cat.name)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => startEdit(cat.name)}
                  >
                    + Map naar WooCommerce
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {filtered?.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">Geen categorieën gevonden</p>
        )}
      </div>
    </div>
  );
};
