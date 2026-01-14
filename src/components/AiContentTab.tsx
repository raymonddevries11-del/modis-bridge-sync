import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  Sparkles, 
  RefreshCw, 
  Check, 
  X, 
  AlertCircle,
  Clock,
  CheckCircle2,
  XCircle
} from "lucide-react";

interface AiContentTabProps {
  product: any;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
  pending: { label: "Wacht op generatie", variant: "secondary", icon: <Clock className="h-3 w-3" /> },
  generated: { label: "Gegenereerd", variant: "default", icon: <Sparkles className="h-3 w-3" /> },
  approved: { label: "Goedgekeurd", variant: "default", icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected: { label: "Afgewezen", variant: "destructive", icon: <XCircle className="h-3 w-3" /> },
};

export const AiContentTab = ({ product }: AiContentTabProps) => {
  const queryClient = useQueryClient();
  const [showComparison, setShowComparison] = useState(false);

  // Fetch AI content for this product
  const { data: aiContent, isLoading, refetch } = useQuery({
    queryKey: ["ai-content", product.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_ai_content")
        .select("*")
        .eq("product_id", product.id)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
  });

  // Generate AI content mutation
  const generateMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("generate-ai-content", {
        body: { productIds: [product.id], tenantId: product.tenant_id },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("AI content gegenereerd");
      refetch();
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: any) => {
      toast.error(`Generatie mislukt: ${error.message}`);
    },
  });

  // Approve/Reject mutation
  const updateStatusMutation = useMutation({
    mutationFn: async ({ status, reason }: { status: string; reason?: string }) => {
      const updateData: any = { status };
      
      if (status === "approved") {
        updateData.approved_at = new Date().toISOString();
        updateData.approved_by = "admin"; // Could be enhanced with actual user
      } else if (status === "rejected") {
        updateData.rejected_at = new Date().toISOString();
        updateData.rejected_reason = reason || null;
      }

      const { error } = await supabase
        .from("product_ai_content")
        .update(updateData)
        .eq("product_id", product.id);

      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      toast.success(variables.status === "approved" ? "Content goedgekeurd" : "Content afgewezen");
      refetch();
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (error: any) => {
      toast.error(`Update mislukt: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No AI content yet
  if (!aiContent) {
    return (
      <div className="space-y-6">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Er is nog geen AI-geoptimaliseerde content voor dit product. Klik op de knop hieronder om te genereren.
          </AlertDescription>
        </Alert>

        <div className="flex justify-center">
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            size="lg"
          >
            <Sparkles className={`h-4 w-4 mr-2 ${generateMutation.isPending ? "animate-pulse" : ""}`} />
            {generateMutation.isPending ? "Genereren..." : "Genereer AI Content"}
          </Button>
        </div>

        {/* Show current product content for reference */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-sm">Huidige Product Data (voor referentie)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <Label className="text-muted-foreground">Titel</Label>
              <p>{product.title || "Geen titel"}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">Beschrijving</Label>
              <p className="whitespace-pre-wrap">{product.webshop_text || "Geen beschrijving"}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = statusConfig[aiContent.status] || statusConfig.pending;

  return (
    <div className="space-y-6">
      {/* Header with status and actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge variant={status.variant} className="flex items-center gap-1">
            {status.icon}
            {status.label}
          </Badge>
          {aiContent.generated_at && (
            <span className="text-xs text-muted-foreground">
              Gegenereerd: {new Date(aiContent.generated_at).toLocaleString("nl-NL")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowComparison(!showComparison)}
          >
            {showComparison ? "Verberg vergelijking" : "Vergelijk met origineel"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${generateMutation.isPending ? "animate-spin" : ""}`} />
            Opnieuw genereren
          </Button>

          {aiContent.status === "generated" && (
            <>
              <Button
                size="sm"
                onClick={() => updateStatusMutation.mutate({ status: "approved" })}
                disabled={updateStatusMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                <Check className="h-4 w-4 mr-1" />
                Goedkeuren
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => updateStatusMutation.mutate({ status: "rejected" })}
                disabled={updateStatusMutation.isPending}
              >
                <X className="h-4 w-4 mr-1" />
                Afwijzen
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Approved/Rejected info */}
      {aiContent.status === "approved" && aiContent.approved_at && (
        <Alert className="border-green-500 bg-green-50">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800">
            Goedgekeurd op {new Date(aiContent.approved_at).toLocaleString("nl-NL")}
            {aiContent.approved_by && ` door ${aiContent.approved_by}`}
          </AlertDescription>
        </Alert>
      )}

      {aiContent.status === "rejected" && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>
            Afgewezen op {aiContent.rejected_at ? new Date(aiContent.rejected_at).toLocaleString("nl-NL") : "onbekend"}
            {aiContent.rejected_reason && `: ${aiContent.rejected_reason}`}
          </AlertDescription>
        </Alert>
      )}

      {/* AI Content Display */}
      <div className={showComparison ? "grid grid-cols-2 gap-6" : "space-y-4"}>
        {showComparison && (
          <div className="space-y-4">
            <h3 className="font-semibold text-sm border-b pb-2">Origineel</h3>
            <ContentField label="Titel" value={product.title} />
            <ContentField label="Korte beschrijving" value={product.internal_description} multiline />
            <ContentField label="Beschrijving" value={product.webshop_text} multiline />
            <ContentField label="Meta titel" value={product.meta_title} />
            <ContentField label="Meta beschrijving" value={product.meta_description} multiline />
          </div>
        )}

        <div className="space-y-4">
          {showComparison && <h3 className="font-semibold text-sm border-b pb-2 text-primary">AI Geoptimaliseerd</h3>}
          
          <ContentField 
            label="AI Titel" 
            value={aiContent.ai_title} 
            highlight={showComparison && aiContent.ai_title !== product.title}
          />
          
          <ContentField 
            label="Korte beschrijving" 
            value={aiContent.ai_short_description} 
            multiline 
            highlight={showComparison}
          />
          
          <ContentField 
            label="Uitgebreide beschrijving" 
            value={aiContent.ai_long_description} 
            multiline 
            highlight={showComparison}
          />
          
          <ContentField 
            label="Meta titel" 
            value={aiContent.ai_meta_title} 
            highlight={showComparison}
            charLimit={60}
          />
          
          <ContentField 
            label="Meta beschrijving" 
            value={aiContent.ai_meta_description} 
            multiline 
            highlight={showComparison}
            charLimit={155}
          />
          
          <ContentField 
            label="Keywords" 
            value={aiContent.ai_keywords} 
          />

          {/* Features */}
          {aiContent.ai_features && Array.isArray(aiContent.ai_features) && aiContent.ai_features.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Product Features</Label>
              <ul className="list-disc list-inside space-y-1">
                {(aiContent.ai_features as string[]).map((feature: string, idx: number) => (
                  <li key={idx} className="text-sm">{feature}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Suggested Categories */}
          {aiContent.ai_suggested_categories && Array.isArray(aiContent.ai_suggested_categories) && aiContent.ai_suggested_categories.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Voorgestelde Categorieën</Label>
              <div className="flex flex-wrap gap-2">
                {(aiContent.ai_suggested_categories as string[]).map((cat: string, idx: number) => (
                  <Badge key={idx} variant="outline">{cat}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface ContentFieldProps {
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
  highlight?: boolean;
  charLimit?: number;
}

const ContentField = ({ label, value, multiline, highlight, charLimit }: ContentFieldProps) => {
  const displayValue = value || "Niet beschikbaar";
  const charCount = value?.length || 0;
  const isOverLimit = charLimit && charCount > charLimit;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        {charLimit && (
          <span className={`text-xs ${isOverLimit ? "text-destructive" : "text-muted-foreground"}`}>
            {charCount}/{charLimit}
          </span>
        )}
      </div>
      {multiline ? (
        <Textarea
          value={displayValue}
          readOnly
          className={`resize-none ${highlight ? "border-primary bg-primary/5" : ""}`}
          rows={4}
        />
      ) : (
        <Input
          value={displayValue}
          readOnly
          className={highlight ? "border-primary bg-primary/5" : ""}
        />
      )}
    </div>
  );
};
