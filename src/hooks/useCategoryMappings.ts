import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface WooCategoryMapping {
  id: string;
  tenant_id: string;
  source_category: string;
  woo_category: string;
  created_at: string;
  updated_at: string;
}

export const useCategoryMappings = (tenantId?: string) => {
  const queryClient = useQueryClient();

  const { data: mappings, isLoading } = useQuery({
    queryKey: ["woo-category-mappings", tenantId],
    queryFn: async () => {
      let query = supabase
        .from("woo_category_mappings" as any)
        .select("*")
        .order("source_category");
      if (tenantId) {
        query = query.eq("tenant_id", tenantId);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as unknown as WooCategoryMapping[];
    },
  });

  const upsertMapping = useMutation({
    mutationFn: async ({
      source_category,
      woo_category,
      tenant_id,
    }: {
      source_category: string;
      woo_category: string;
      tenant_id: string;
    }) => {
      const { error } = await supabase
        .from("woo_category_mappings" as any)
        .upsert(
          { source_category, woo_category, tenant_id, updated_at: new Date().toISOString() } as any,
          { onConflict: "tenant_id,source_category" }
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["woo-category-mappings"] });
      toast.success("Mapping opgeslagen");
    },
    onError: (err: any) => toast.error(`Fout: ${err.message}`),
  });

  const deleteMapping = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("woo_category_mappings" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["woo-category-mappings"] });
      toast.success("Mapping verwijderd");
    },
    onError: (err: any) => toast.error(`Fout: ${err.message}`),
  });

  return { mappings, isLoading, upsertMapping, deleteMapping };
};
