import { Card, CardContent } from "@/components/ui/card";
import { Link2, Unlink, Layers, Tag, AlertTriangle, CheckCircle2 } from "lucide-react";

interface HealthStats {
  totalAttributes: number | null;
  mappedAttributes: number;
  totalCategories: number | null;
  mappedCategories: number;
}

interface Props {
  stats: HealthStats | null;
  isLoading: boolean;
}

export function CatalogHealthBar({ stats, isLoading }: Props) {
  if (!stats) {
    return null;
  }

  const totalAttrs = stats.totalAttributes ?? 0;
  const totalCats = stats.totalCategories ?? 0;
  const attrPct = totalAttrs > 0
    ? Math.round((stats.mappedAttributes / totalAttrs) * 100)
    : 0;
  const catPct = totalCats > 0
    ? Math.round((stats.mappedCategories / totalCats) * 100)
    : 0;
  const unmappedAttrs = totalAttrs - stats.mappedAttributes;
  const unmappedCats = totalCats - stats.mappedCategories;

  const cards = [
    {
      label: "Attributen",
      value: stats.totalAttributes !== null ? totalAttrs : "–",
      icon: Layers,
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      label: "Attr. gematcht",
      value: stats.totalAttributes !== null ? `${attrPct}%` : "–",
      sub: stats.totalAttributes !== null ? `${stats.mappedAttributes} / ${totalAttrs}` : undefined,
      icon: attrPct === 100 ? CheckCircle2 : Link2,
      color: attrPct === 100 ? "text-emerald-600" : "text-blue-600",
      bgColor: attrPct === 100 ? "bg-emerald-50" : "bg-blue-50",
    },
    {
      label: "Categorieën",
      value: stats.totalCategories !== null ? totalCats : "–",
      icon: Tag,
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      label: "Cat. gematcht",
      value: stats.totalCategories !== null ? `${catPct}%` : "–",
      sub: stats.totalCategories !== null ? `${stats.mappedCategories} / ${totalCats}` : undefined,
      icon: catPct === 100 ? CheckCircle2 : (unmappedCats > 0 ? Unlink : Link2),
      color: catPct === 100 ? "text-emerald-600" : (unmappedCats > 0 ? "text-amber-600" : "text-blue-600"),
      bgColor: catPct === 100 ? "bg-emerald-50" : (unmappedCats > 0 ? "bg-amber-50" : "bg-blue-50"),
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="p-4 flex items-start gap-3">
            <div className={`rounded-lg p-2 ${card.bgColor}`}>
              <card.icon className={`h-4 w-4 ${card.color}`} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground truncate">{card.label}</p>
              <p className="text-lg font-semibold leading-tight">{card.value}</p>
              {card.sub && (
                <p className="text-[10px] text-muted-foreground">{card.sub}</p>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}