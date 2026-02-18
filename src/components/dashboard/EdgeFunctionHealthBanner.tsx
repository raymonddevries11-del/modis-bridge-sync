import { useEffect, useState } from "react";
import { getCircuitStatus, resetCircuitBreaker } from "@/lib/edge-function-client";
import { AlertTriangle, CheckCircle2, RefreshCw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

const WATCHED_FUNCTIONS = [
  "compare-product",
  "push-to-woocommerce",
  "generate-ai-content",
  "fetch-woo-product-list",
  "sync-watchdog",
  "woocommerce-sync",
];

export function EdgeFunctionHealthBanner() {
  const [statuses, setStatuses] = useState<
    { name: string; state: string; failures: number; cooldownRemaining: number }[]
  >([]);

  useEffect(() => {
    const poll = () => {
      setStatuses(
        WATCHED_FUNCTIONS.map((fn) => ({ name: fn, ...getCircuitStatus(fn) }))
      );
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  const troubled = statuses.filter((s) => s.failures > 0);
  const openCircuits = statuses.filter((s) => s.state === "open");

  if (troubled.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
        openCircuits.length > 0
          ? "border-destructive/30 bg-destructive/5"
          : "border-warning/30 bg-warning/5"
      }`}
    >
      <Zap className="h-4 w-4 flex-shrink-0 text-warning" />
      <span className="font-medium">Edge Functions</span>

      <div className="flex flex-wrap items-center gap-2 flex-1">
        {troubled.map((fn) => {
          const isOpen = fn.state === "open";
          const isHalfOpen = fn.state === "half-open";
          return (
            <span
              key={fn.name}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
                isOpen
                  ? "bg-destructive/10 text-destructive"
                  : isHalfOpen
                  ? "bg-warning/10 text-warning"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {isOpen ? (
                <AlertTriangle className="h-3 w-3" />
              ) : isHalfOpen ? (
                <RefreshCw className="h-3 w-3" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {fn.name}
              {fn.failures > 0 && <span>({fn.failures}×)</span>}
              {isOpen && fn.cooldownRemaining > 0 && (
                <span className="opacity-70">{Math.ceil(fn.cooldownRemaining / 1000)}s</span>
              )}
              {isOpen && (
                <button
                  onClick={() => resetCircuitBreaker(fn.name)}
                  className="ml-1 underline text-[11px] opacity-80 hover:opacity-100"
                >
                  reset
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
