import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShieldAlert, ShieldCheck, AlertTriangle, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface ConflictState {
  checked_at: string;
  total_triggers: number;
  job_writer_count: number;
  pending_writer_count: number;
  conflicts: number;
  unsafe_triggers: number;
  severity: "critical" | "warning" | "ok";
  job_duplicates: { table: string; triggers: { name: string; function: string }[] }[];
  pending_duplicates: { table: string; triggers: { name: string; function: string }[] }[];
  unsafe_trigger_names: { trigger: string; table: string; function: string; missing: string[] }[];
}

export const TriggerConflictAlert = () => {
  const navigate = useNavigate();

  const { data: state } = useQuery({
    queryKey: ["trigger-conflict-state"],
    queryFn: async (): Promise<ConflictState | null> => {
      const { data } = await supabase
        .from("config")
        .select("value")
        .eq("key", "trigger_conflict_state")
        .single();
      if (!data?.value) return null;
      return data.value as unknown as ConflictState;
    },
    refetchInterval: 30000,
  });

  if (!state || state.severity === "ok") return null;

  const checkedAgo = state.checked_at
    ? (() => {
        const mins = Math.floor((Date.now() - new Date(state.checked_at).getTime()) / 60000);
        if (mins < 1) return "zojuist";
        if (mins < 60) return `${mins}m geleden`;
        return `${Math.floor(mins / 60)}u geleden`;
      })()
    : "";

  const isCritical = state.severity === "critical";

  return (
    <Alert
      variant={isCritical ? "destructive" : "default"}
      className={isCritical
        ? "border-destructive/50 bg-destructive/5"
        : "border-warning/50 bg-warning/5"
      }
    >
      {isCritical ? (
        <ShieldAlert className="h-4 w-4" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-warning" />
      )}
      <AlertTitle className="flex items-center gap-2">
        {isCritical ? "Trigger-conflicten gedetecteerd" : "Trigger-waarschuwingen"}
        <Badge variant={isCritical ? "destructive" : "outline"} className="text-[10px] px-1.5 py-0">
          {state.conflicts} conflict{state.conflicts !== 1 ? "en" : ""}
          {state.unsafe_triggers > 0 && ` · ${state.unsafe_triggers} onveilig`}
        </Badge>
      </AlertTitle>
      <AlertDescription className="mt-1 space-y-2">
        {state.conflicts > 0 && (
          <div className="text-sm">
            <strong>Duplicaten:</strong>{" "}
            {[...state.job_duplicates, ...state.pending_duplicates].map((d, i) => (
              <span key={i}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <code className="text-xs bg-muted px-1 rounded cursor-help">{d.table}</code>
                  </TooltipTrigger>
                  <TooltipContent>
                    {d.triggers.map((t) => (
                      <div key={t.name} className="text-xs">{t.name} → {t.function}()</div>
                    ))}
                  </TooltipContent>
                </Tooltip>
                {i < state.job_duplicates.length + state.pending_duplicates.length - 1 && ", "}
              </span>
            ))}
          </div>
        )}
        {state.unsafe_triggers > 0 && (
          <div className="text-sm">
            <strong>Zonder safeguards:</strong>{" "}
            {state.unsafe_trigger_names.map((t, i) => (
              <span key={i}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <code className="text-xs bg-muted px-1 rounded cursor-help">{t.trigger}</code>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="text-xs">Tabel: {t.table}</div>
                    <div className="text-xs">Functie: {t.function}()</div>
                    <div className="text-xs">Ontbreekt: {t.missing.join(", ")}</div>
                  </TooltipContent>
                </Tooltip>
                {i < state.unsafe_trigger_names.length - 1 && ", "}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={() => navigate("/trigger-audit")}
          >
            <ExternalLink className="h-3 w-3 mr-1" /> Trigger Audit
          </Button>
          <span className="text-[10px] text-muted-foreground">Laatst gecontroleerd: {checkedAgo}</span>
        </div>
      </AlertDescription>
    </Alert>
  );
};
