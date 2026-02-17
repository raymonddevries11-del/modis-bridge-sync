import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Gauge, TrendingUp } from "lucide-react";

interface QueueHealthState {
  alert_active: boolean;
  grace_started_at: string | null;
  alerted_at: string | null;
  cleared_at: string | null;
  queue_size: number;
  threshold: number;
  scaled_batch_size?: number;
}

export const QueueHealthAlert = () => {
  const { data: healthState } = useQuery({
    queryKey: ["queue-health-state"],
    queryFn: async (): Promise<QueueHealthState | null> => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", "job_queue_health")
        .single();
      if (!data?.value) return null;
      return data.value as unknown as QueueHealthState;
    },
    refetchInterval: 10000,
  });

  // Show nothing if no alert state or not active/grace
  if (!healthState) return null;

  const isGracePeriod = healthState.grace_started_at && !healthState.alert_active;
  const isActive = healthState.alert_active;

  if (!isGracePeriod && !isActive) return null;

  const graceAt = healthState.grace_started_at
    ? new Date(healthState.grace_started_at).toLocaleString("nl-NL", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  if (isGracePeriod) {
    return (
      <Alert className="border-warning/50 bg-warning/5">
        <TrendingUp className="h-4 w-4 text-warning" />
        <AlertTitle>Wachtrij groeit — grace period</AlertTitle>
        <AlertDescription className="text-sm mt-1">
          De job-wachtrij staat op <strong>{healthState.queue_size}</strong> (drempel: {healthState.threshold}).
          Auto-scaling is geactiveerd (batch size → {healthState.scaled_batch_size ?? "15"}).
          Als de wachtrij niet daalt wordt een alert gegeven.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" className="border-destructive/50 bg-destructive/5">
      <Gauge className="h-4 w-4" />
      <AlertTitle>Hoge wachtrij — auto-scaling actief</AlertTitle>
      <AlertDescription className="text-sm mt-1">
        De job-wachtrij staat op <strong>{healthState.queue_size}</strong> jobs (drempel: {healthState.threshold}).
        Auto-scaling is actief sinds {graceAt}: batch size verhoogd naar {healthState.scaled_batch_size ?? "15"} en
        chained invocations zijn ingeschakeld. Controleer of de worker snel genoeg verwerkt.
      </AlertDescription>
    </Alert>
  );
};
