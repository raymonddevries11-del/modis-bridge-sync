import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ShieldAlert, Play, Loader2 } from "lucide-react";
import { toast } from "sonner";

const CIRCUIT_BREAKER_KEY = "woo_sync_circuit_breaker";

interface CircuitBreakerState {
  paused: boolean;
  consecutive_blocks: number;
  paused_at: string | null;
  last_block_at: string | null;
  total_blocks_24h: number;
}

export const CircuitBreakerAlert = () => {
  const queryClient = useQueryClient();

  const { data: cbState } = useQuery({
    queryKey: ["circuit-breaker-state"],
    queryFn: async (): Promise<CircuitBreakerState | null> => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", CIRCUIT_BREAKER_KEY)
        .single();
      if (!data?.value) return null;
      return data.value as unknown as CircuitBreakerState;
    },
    refetchInterval: 10000,
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const resetState: CircuitBreakerState = {
        paused: false,
        consecutive_blocks: 0,
        paused_at: null,
        last_block_at: cbState?.last_block_at || null,
        total_blocks_24h: cbState?.total_blocks_24h || 0,
      };
      const { error } = await supabase.from("config").upsert(
        { key: CIRCUIT_BREAKER_KEY, value: resetState as any, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Sync hervat — circuit breaker gereset");
      queryClient.invalidateQueries({ queryKey: ["circuit-breaker-state"] });
    },
    onError: (e: any) => toast.error(`Fout bij hervatten: ${e.message}`),
  });

  if (!cbState?.paused) return null;

  const pausedAt = cbState.paused_at
    ? new Date(cbState.paused_at).toLocaleString("nl-NL", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "onbekend";

  return (
    <Alert variant="destructive" className="border-destructive/50 bg-destructive/5">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle className="flex items-center justify-between">
        <span>Sync gepauzeerd — Bot protection</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-4 gap-1.5"
          onClick={() => resumeMutation.mutate()}
          disabled={resumeMutation.isPending}
        >
          {resumeMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Hervat sync
        </Button>
      </AlertTitle>
      <AlertDescription className="text-sm mt-1">
        Na {cbState.consecutive_blocks} opeenvolgende geblokkeerde requests is de sync automatisch
        gepauzeerd op {pausedAt}. Controleer de SiteGround bot protection instellingen voordat je hervat.
      </AlertDescription>
    </Alert>
  );
};
