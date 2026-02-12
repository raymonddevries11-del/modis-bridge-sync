import { useState, useEffect, useRef } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Top-level Google Product Categories for apparel/shoes/accessories
// Source: https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt
const GOOGLE_CATEGORIES = [
  "Apparel & Accessories",
  "Apparel & Accessories > Clothing",
  "Apparel & Accessories > Clothing > Activewear",
  "Apparel & Accessories > Clothing > Dresses",
  "Apparel & Accessories > Clothing > Outerwear",
  "Apparel & Accessories > Clothing > Outerwear > Coats & Jackets",
  "Apparel & Accessories > Clothing > Pants",
  "Apparel & Accessories > Clothing > Shirts & Tops",
  "Apparel & Accessories > Clothing > Shorts",
  "Apparel & Accessories > Clothing > Skirts",
  "Apparel & Accessories > Clothing > Sleepwear & Loungewear",
  "Apparel & Accessories > Clothing > Suits",
  "Apparel & Accessories > Clothing > Swimwear",
  "Apparel & Accessories > Clothing > Underwear & Socks",
  "Apparel & Accessories > Clothing > Underwear & Socks > Socks",
  "Apparel & Accessories > Clothing > Underwear & Socks > Underwear",
  "Apparel & Accessories > Clothing > Uniforms",
  "Apparel & Accessories > Clothing Accessories",
  "Apparel & Accessories > Clothing Accessories > Belts",
  "Apparel & Accessories > Clothing Accessories > Gloves & Mittens",
  "Apparel & Accessories > Clothing Accessories > Hats",
  "Apparel & Accessories > Clothing Accessories > Scarves & Shawls",
  "Apparel & Accessories > Clothing Accessories > Sunglasses",
  "Apparel & Accessories > Clothing Accessories > Ties & Accessories",
  "Apparel & Accessories > Handbags, Wallets & Cases",
  "Apparel & Accessories > Handbags, Wallets & Cases > Handbags",
  "Apparel & Accessories > Handbags, Wallets & Cases > Wallets & Money Clips",
  "Apparel & Accessories > Jewelry",
  "Apparel & Accessories > Jewelry > Bracelets",
  "Apparel & Accessories > Jewelry > Earrings",
  "Apparel & Accessories > Jewelry > Necklaces",
  "Apparel & Accessories > Jewelry > Rings",
  "Apparel & Accessories > Jewelry > Watches",
  "Apparel & Accessories > Shoes",
  "Apparel & Accessories > Shoes > Athletic Shoes",
  "Apparel & Accessories > Shoes > Boots",
  "Apparel & Accessories > Shoes > Clogs & Mules",
  "Apparel & Accessories > Shoes > Flats",
  "Apparel & Accessories > Shoes > Loafers & Slip-Ons",
  "Apparel & Accessories > Shoes > Oxfords",
  "Apparel & Accessories > Shoes > Sandals",
  "Apparel & Accessories > Shoes > Slippers",
  "Apparel & Accessories > Shoes > Sneakers",
  "Apparel & Accessories > Shoes > Heels",
  "Apparel & Accessories > Shoe Accessories",
  "Apparel & Accessories > Shoe Accessories > Insoles & Inserts",
  "Apparel & Accessories > Shoe Accessories > Shoe Laces",
  "Apparel & Accessories > Shoe Accessories > Shoelaces",
  "Apparel & Accessories > Costumes & Accessories",
  "Baby & Toddler > Baby & Toddler Clothing",
  "Baby & Toddler > Baby & Toddler Clothing > Baby & Toddler Bottoms",
  "Baby & Toddler > Baby & Toddler Clothing > Baby & Toddler Outerwear",
  "Baby & Toddler > Baby & Toddler Clothing > Baby & Toddler Tops",
  "Baby & Toddler > Baby & Toddler Shoes",
  "Luggage & Bags",
  "Luggage & Bags > Backpacks",
  "Luggage & Bags > Duffel Bags",
  "Luggage & Bags > Shopping Totes",
  "Luggage & Bags > Suitcases",
  "Sporting Goods > Athletics > Running > Running Shoes",
  "Sporting Goods > Athletics > Walking > Walking Shoes",
  "Sporting Goods > Outdoor Recreation > Hiking > Hiking Boots",
  "Health & Beauty > Personal Care > Foot Care",
];

interface GoogleCategorySearchProps {
  value: string;
  onSelect: (value: string) => void;
}

export function GoogleCategorySearch({ value, onSelect }: GoogleCategorySearchProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

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
        <Command shouldFilter={true}>
          <CommandInput
            placeholder="Zoek categorie (bijv. shoes, boots)..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
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
            <CommandGroup heading="Google Product Categorieën">
              {GOOGLE_CATEGORIES.map((cat) => (
                <CommandItem
                  key={cat}
                  value={cat}
                  onSelect={() => {
                    onSelect(cat);
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value === cat ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="text-sm">{cat}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {/* Allow custom input */}
        {search && !GOOGLE_CATEGORIES.some(c => c.toLowerCase() === search.toLowerCase()) && (
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
