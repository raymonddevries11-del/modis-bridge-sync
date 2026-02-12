export interface CompletenessResult {
  score: number; // 0-100
  checks: { label: string; passed: boolean; weight: number }[];
}

export function calculateCompleteness(product: any, aiContent?: any): CompletenessResult {
  const approvedAi = aiContent?.status === "approved" ? aiContent : null;

  const checks = [
    { label: "Titel", passed: !!product.title?.trim(), weight: 10 },
    { label: "SKU", passed: !!product.sku?.trim(), weight: 5 },
    { label: "Merk", passed: !!product.brands?.name, weight: 5 },
    { label: "Afbeeldingen", passed: Array.isArray(product.images) && product.images.length > 0, weight: 20 },
    { label: "Prijs", passed: Number(product.product_prices?.regular || 0) > 0, weight: 15 },
    { label: "Beschrijving", passed: !!(product.webshop_text?.trim() || approvedAi?.ai_long_description?.trim()), weight: 15 },
    { label: "Meta titel", passed: !!(product.meta_title?.trim() || approvedAi?.ai_meta_title?.trim()), weight: 5 },
    { label: "Meta description", passed: !!(product.meta_description?.trim() || approvedAi?.ai_meta_description?.trim()), weight: 5 },
    { label: "Varianten", passed: product.variants?.length > 0, weight: 10 },
    { label: "Voorraad", passed: product.variants?.some((v: any) => v.stock_totals?.qty > 0), weight: 10 },
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
