export interface CompletenessResult {
  score: number; // 0-100
  checks: { label: string; passed: boolean; weight: number }[];
}

export function calculateCompleteness(product: any, aiContent?: any): CompletenessResult {
  const approvedAi = aiContent?.status === "approved" ? aiContent : null;

  const attrs = product.attributes as Record<string, any> | null;
  const attrCount = attrs ? Object.keys(attrs).length : 0;
  const cats = Array.isArray(product.categories) ? product.categories : [];
  const variants = product.variants || [];
  const isSimple = product.product_type === "simple";
  const allVariantsHaveEan = isSimple || (variants.length > 0 && variants.every((v: any) => v.ean && v.ean !== "0" && v.ean !== ""));

  const checks = [
    { label: "Titel", passed: !!product.title?.trim(), weight: 10 },
    { label: "SKU", passed: !!product.sku?.trim(), weight: 5 },
    { label: "Merk", passed: !!product.brands?.name, weight: 5 },
    { label: "Afbeeldingen", passed: Array.isArray(product.images) && product.images.length > 0, weight: 15 },
    { label: "Prijs", passed: Number(product.product_prices?.regular || 0) > 0, weight: 10 },
    { label: "Beschrijving", passed: !!(product.webshop_text?.trim() || approvedAi?.ai_long_description?.trim()), weight: 10 },
    { label: "Meta titel", passed: !!(product.meta_title?.trim() || approvedAi?.ai_meta_title?.trim()), weight: 5 },
    { label: "Meta description", passed: !!(product.meta_description?.trim() || approvedAi?.ai_meta_description?.trim()), weight: 5 },
    { label: "Attributen", passed: attrCount >= 3, weight: 10 },
    { label: "Categorieën", passed: cats.length > 0, weight: 10 },
    { label: "Varianten", passed: isSimple || variants.length > 0, weight: 5 },
    { label: "Voorraad", passed: isSimple || variants.some((v: any) => v.stock_totals?.qty > 0), weight: 5 },
    { label: "EAN codes", passed: allVariantsHaveEan, weight: 5 },
  ];

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
  const score = Math.round((earned / totalWeight) * 100);

  return { score, checks };
}

export function scoreColor(score: number): string {
  if (score >= 80) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-destructive";
}

export function scoreBg(score: number): string {
  if (score >= 80) return "bg-success/15";
  if (score >= 50) return "bg-warning/15";
  return "bg-destructive/15";
}
