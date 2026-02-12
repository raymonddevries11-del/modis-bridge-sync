import { useState, useEffect, useCallback } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

interface GoogleCategorySearchProps {
  value: string;
  onSelect: (value: string) => void;
}

export function GoogleCategorySearch({ value, onSelect }: GoogleCategorySearchProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);

  const fetchCategories = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('google-taxonomy', {
        body: { q: query, limit: 50 },
      });

      if (error) throw error;

      if (data?.categories) {
        setCategories(data.categories);
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to fetch taxonomy:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    if (!open) return;

    const timer = setTimeout(() => {
      fetchCategories(search);
    }, 300);

    return () => clearTimeout(timer);
  }, [search, open, fetchCategories]);

  // Load initial categories when popover opens
  useEffect(() => {
    if (open) {
      fetchCategories(search);
    }
  }, [open]);

  const displayValue = value || "Zoek Google categorie...";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal text-left h-auto min-h-10"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {displayValue}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Zoek categorie (bijv. shoes, boots, clothing)..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Zoeken...</span>
              </div>
            ) : categories.length === 0 ? (
              <CommandEmpty>
                <div className="py-2 text-sm">
                  <p>Geen resultaat gevonden.</p>
                  <p className="text-muted-foreground mt-1">
                    Typ de categorie handmatig of bekijk de{" "}
                    <a
                      href="https://support.google.com/merchants/answer/6324436"
                      target="_blank"
                      rel="noopener"
                      className="underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Google Taxonomy
                    </a>
                  </p>
                </div>
              </CommandEmpty>
            ) : (
              <CommandGroup heading={`Google Product Categorieën (${total} totaal)`}>
                {categories.map((cat) => (
                  <CommandItem
                    key={cat.id}
                    value={cat.id}
                    onSelect={() => {
                      onSelect(cat.name);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 shrink-0",
                        value === cat.name ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="text-sm">{cat.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        {/* Allow custom input */}
        {search && !loading && !categories.some(c => c.name.toLowerCase() === search.toLowerCase()) && (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-sm"
              onClick={() => {
                onSelect(search);
                setOpen(false);
                setSearch("");
              }}
            >
              Gebruik: "{search}"
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
