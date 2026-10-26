import { createHash } from "node:crypto";

export const DEFAULT_MODEL_CALL_LIMIT = 150;
export const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_TOOL_RETRY_LIMIT = 3;

export type RunGuardStopReason = "model_call_limit" | "idle_timeout" | "tool_retry_loop";

export interface RunGuardDecision {
  stop: boolean;
  reason?: RunGuardStopReason;
}

export interface RunGuardOptions {
  modelCallLimit?: number;
  idleTimeoutMs?: number;
  toolRetryLimit?: number;
  now?: () => number;
}

/**
 * Pure, adapter-neutral run circuit breaker. Callers provide already-classified
 * model/tool events; no tool arguments or provider payloads are retained.
 */
export class RunGuard {
  private readonly modelCallLimit: number;
  private readonly idleTimeoutMs: number;
  private readonly toolRetryLimit: number;
  private readonly now: () => number;
  private modelCalls = 0;
  private lastEventAt: number;
  private lastToolFailure: string | null = null;
  private toolFailureCount = 0;

  constructor(options: RunGuardOptions = {}) {
    this.modelCallLimit = options.modelCallLimit ?? DEFAULT_MODEL_CALL_LIMIT;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.toolRetryLimit = options.toolRetryLimit ?? DEFAULT_TOOL_RETRY_LIMIT;
    this.now = options.now ?? Date.now;
    this.lastEventAt = this.now();
  }

  modelCall(): RunGuardDecision {
    this.modelCalls += 1;
    this.lastEventAt = this.now();
    return this.modelCalls > this.modelCallLimit
      ? { stop: true, reason: "model_call_limit" }
      : { stop: false };
  }

  /** Record a provider/tool event without retaining its payload. */
  event(): RunGuardDecision {
    this.lastEventAt = this.now();
    this.lastToolFailure = null;
    this.toolFailureCount = 0;
    return { stop: false };
  }

  idle(): RunGuardDecision {
    return this.now() - this.lastEventAt >= this.idleTimeoutMs
      ? { stop: true, reason: "idle_timeout" }
      : { stop: false };
  }

  toolSuccess(): RunGuardDecision {
    return this.event();
  }

  toolFailure(name: string, args: unknown): RunGuardDecision {
    const signature = toolFailureSignature(name, args);
    if (signature === this.lastToolFailure) this.toolFailureCount += 1;
    else {
      this.lastToolFailure = signature;
      this.toolFailureCount = 1;
    }
    this.lastEventAt = this.now();
    return this.toolFailureCount >= this.toolRetryLimit
      ? { stop: true, reason: "tool_retry_loop" }
      : { stop: false };
  }
}

export function toolFailureSignature(name: string, args: unknown): string {
  return createHash("sha256").update(`${name}\u0000${stableJson(args)}`).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
