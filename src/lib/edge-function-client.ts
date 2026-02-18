import { supabase } from "@/integrations/supabase/client";

/**
 * Circuit Breaker states for edge function invocations.
 * Prevents hammering a failing edge function.
 */
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
}

const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures to trip
const CIRCUIT_BREAKER_RESET_MS = 60_000; // 60s before half-open

const circuitBreakers = new Map<string, CircuitBreakerState>();

function getCircuitBreaker(fnName: string): CircuitBreakerState {
  if (!circuitBreakers.has(fnName)) {
    circuitBreakers.set(fnName, { failures: 0, lastFailure: 0, state: "closed" });
  }
  return circuitBreakers.get(fnName)!;
}

function recordSuccess(fnName: string) {
  const cb = getCircuitBreaker(fnName);
  cb.failures = 0;
  cb.state = "closed";
}

function recordFailure(fnName: string) {
  const cb = getCircuitBreaker(fnName);
  cb.failures++;
  cb.lastFailure = Date.now();
  if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    cb.state = "open";
  }
}

function canAttempt(fnName: string): boolean {
  const cb = getCircuitBreaker(fnName);
  if (cb.state === "closed") return true;
  if (cb.state === "open") {
    if (Date.now() - cb.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
      cb.state = "half-open";
      return true;
    }
    return false;
  }
  // half-open: allow one attempt
  return true;
}

/** Returns the current circuit breaker status for a function (for UI display) */
export function getCircuitStatus(fnName: string): { state: string; failures: number; cooldownRemaining: number } {
  const cb = getCircuitBreaker(fnName);
  const remaining = cb.state === "open"
    ? Math.max(0, CIRCUIT_BREAKER_RESET_MS - (Date.now() - cb.lastFailure))
    : 0;
  return { state: cb.state, failures: cb.failures, cooldownRemaining: remaining };
}

/** Reset the circuit breaker for a specific function (e.g., from a UI button) */
export function resetCircuitBreaker(fnName: string) {
  circuitBreakers.delete(fnName);
}

interface InvokeOptions {
  body?: Record<string, unknown>;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay?: number;
  /** Max delay cap in ms (default: 15000) */
  maxDelay?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export class EdgeFunctionError extends Error {
  public readonly functionName: string;
  public readonly attempt: number;
  public readonly isCircuitOpen: boolean;

  constructor(message: string, functionName: string, attempt: number, isCircuitOpen = false) {
    super(message);
    this.name = "EdgeFunctionError";
    this.functionName = functionName;
    this.attempt = attempt;
    this.isCircuitOpen = isCircuitOpen;
  }
}

/**
 * Invoke a Supabase Edge Function with automatic retry (exponential backoff)
 * and circuit breaker protection.
 *
 * @example
 * const data = await invokeEdgeFunction("compare-product", {
 *   body: { productId, tenantId },
 *   maxRetries: 2,
 * });
 */
export async function invokeEdgeFunction<T = unknown>(
  functionName: string,
  options: InvokeOptions = {}
): Promise<T> {
  const {
    body,
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 15000,
    signal,
  } = options;

  // Circuit breaker check
  if (!canAttempt(functionName)) {
    const status = getCircuitStatus(functionName);
    throw new EdgeFunctionError(
      `Circuit breaker open voor "${functionName}" (${status.failures} opeenvolgende fouten). Wacht ${Math.ceil(status.cooldownRemaining / 1000)}s.`,
      functionName,
      0,
      true
    );
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check abort signal
    if (signal?.aborted) {
      throw new EdgeFunctionError("Request afgebroken", functionName, attempt);
    }

    // Exponential backoff with jitter (skip delay on first attempt)
    if (attempt > 0) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = delay * (0.5 + Math.random() * 0.5); // 50-100% of delay
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }

    try {
      const { data, error } = await supabase.functions.invoke(functionName, {
        body: body ?? {},
      });

      if (error) {
        throw new Error(error.message || `Edge function "${functionName}" failed`);
      }

      // Success: reset circuit breaker
      recordSuccess(functionName);
      return data as T;
    } catch (err: any) {
      lastError = err;
      recordFailure(functionName);

      // Don't retry on client errors (4xx-like) — only on transport/timeout failures
      const msg = err?.message?.toLowerCase() || "";
      const isRetryable =
        msg.includes("failed to send") ||
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("504") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("529");

      if (!isRetryable) {
        throw new EdgeFunctionError(
          err.message || `Edge function "${functionName}" failed`,
          functionName,
          attempt
        );
      }

      // Check if circuit just tripped
      if (!canAttempt(functionName)) {
        throw new EdgeFunctionError(
          `Circuit breaker geactiveerd na ${CIRCUIT_BREAKER_THRESHOLD} fouten voor "${functionName}"`,
          functionName,
          attempt,
          true
        );
      }

      console.warn(
        `[EdgeFunction] ${functionName} attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}. Retrying...`
      );
    }
  }

  throw new EdgeFunctionError(
    lastError?.message || `Alle ${maxRetries + 1} pogingen mislukt voor "${functionName}"`,
    functionName,
    maxRetries
  );
}
