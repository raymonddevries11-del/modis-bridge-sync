import { Card, CardContent } from "@/components/ui/card";
import { Link2, Unlink, Layers, Tag, AlertTriangle, CheckCircle2 } from "lucide-react";

interface HealthStats {
  totalAttributes: number;
  mappedAttributes: number;
  totalCategories: number;
  mappedCategories: number;
}

interface Props {
  stats: HealthStats | null;
  isLoading: boolean;
}

export function CatalogHealthBar({ stats, isLoading }: Props) {
  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-4">
              <div className="h-4 bg-muted rounded w-24 mb-2" />
              <div className="h-7 bg-muted rounded w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const attrPct = stats.totalAttributes > 0
    ? Math.round((stats.mappedAttributes / stats.totalAttributes) * 100)
    : 0;
  const catPct = stats.totalCategories > 0
    ? Math.round((stats.mappedCategories / stats.totalCategories) * 100)
    : 0;
  const unmappedAttrs = stats.totalAttributes - stats.mappedAttributes;
  const unmappedCats = stats.totalCategories - stats.mappedCategories;
  const totalIssues = unmappedAttrs + unmappedCats;

  const cards = [
    {
      label: "Attributen",
      value: stats.totalAttributes,
      icon: Layers,
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      label: "Attr. gematcht",
      value: `${attrPct}%`,
      sub: `${stats.mappedAttributes} / ${stats.totalAttributes}`,
      icon: attrPct === 100 ? CheckCircle2 : Link2,
      color: attrPct === 100 ? "text-emerald-600" : "text-blue-600",
      bgColor: attrPct === 100 ? "bg-emerald-50" : "bg-blue-50",
    },
    {
      label: "Categorieën",
      value: stats.totalCategories,
      icon: Tag,
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      label: "Cat. gematcht",
      value: `${catPct}%`,
      sub: `${stats.mappedCategories} / ${stats.totalCategories}`,
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