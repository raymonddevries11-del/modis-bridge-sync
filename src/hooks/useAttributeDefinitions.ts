import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface AttributeDefinition {
  id: string;
  name: string;
  allowed_values: string[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export const useAttributeDefinitions = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["attribute-definitions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attribute_definitions")
        .select("*")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as AttributeDefinition[];
    },
  });

  const upsertMutation = useMutation({
    mutationFn: async (def: { id?: string; name: string; allowed_values: string[]; sort_order?: number }) => {
      if (def.id) {
        const { error } = await supabase
          .from("attribute_definitions")
          .update({ name: def.name, allowed_values: def.allowed_values, sort_order: def.sort_order ?? 0 })
          .eq("id", def.id);
        if (error) throw error;
      } else {
        const maxOrder = query.data?.reduce((m, d) => Math.max(m, d.sort_order), 0) ?? 0;
        const { error } = await supabase
          .from("attribute_definitions")
          .insert({ name: def.name, allowed_values: def.allowed_values, sort_order: def.sort_order ?? maxOrder + 1 });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["attribute-definitions"] });
    },
    onError: (e: any) => toast.error(`Fout: ${e.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("attribute_definitions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["attribute-definitions"] });
    },
    onError: (e: any) => toast.error(`Verwijderen mislukt: ${e.message}`),
  });

  return {
    definitions: query.data ?? [],
    isLoading: query.isLoading,
    upsert: upsertMutation.mutateAsync,
    remove: deleteMutation.mutateAsync,
    isUpsertPending: upsertMutation.isPending,
    isDeletePending: deleteMutation.isPending,
  };
};

/** Helper: build lookup maps from definitions */
export const buildAttributeLookups = (defs: AttributeDefinition[]) => {
  const names = defs.map((d) => d.name);
  const valuesMap: Record<string, string[]> = {};
  for (const d of defs) {
    valuesMap[d.name] = d.allowed_values;
  }
  return { names, valuesMap };
};
