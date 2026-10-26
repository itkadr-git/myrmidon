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
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCallback: (() => void) | null = null;
  private lastToolFailure: string | null = null;
  private toolFailureCount = 0;
  private stoppedReason: RunGuardStopReason | null = null;

  constructor(options: RunGuardOptions = {}) {
    this.modelCallLimit = options.modelCallLimit ?? DEFAULT_MODEL_CALL_LIMIT;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.toolRetryLimit = options.toolRetryLimit ?? DEFAULT_TOOL_RETRY_LIMIT;
    this.now = options.now ?? Date.now;
    this.lastEventAt = this.now();
  }

  modelCall(): RunGuardDecision {
    if (this.stoppedReason) return { stop: true, reason: this.stoppedReason };
    this.modelCalls += 1;
    if (this.modelCalls > this.modelCallLimit) return this.stop("model_call_limit");
    this.lastEventAt = this.now();
    this.scheduleIdleWatch();
    return { stop: false };
  }

  /** Record a provider/tool event without retaining its payload. */
  event(): RunGuardDecision {
    if (this.stoppedReason) return { stop: true, reason: this.stoppedReason };
    this.lastEventAt = this.now();
    this.scheduleIdleWatch();
    return { stop: false };
  }

  private scheduleIdleWatch(): void {
    if (!this.idleCallback || this.stoppedReason) return;
    this.clearIdleWatch();
    this.idleTimer = setTimeout(() => {
      if (this.stoppedReason) return;
      const onIdle = this.idleCallback;
      const decision = this.idle();
      if (decision.stop) onIdle?.();
    }, Math.max(1, this.idleTimeoutMs - (this.now() - this.lastEventAt)));
  }

  startIdleWatch(onIdle: () => void): void {
    this.idleCallback = onIdle;
    this.scheduleIdleWatch();
  }

  clearIdleWatch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  idle(): RunGuardDecision {
    return this.now() - this.lastEventAt >= this.idleTimeoutMs
      ? this.stop("idle_timeout")
      : { stop: false };
  }

  stop(reason: RunGuardStopReason): RunGuardDecision {
    this.stoppedReason ??= reason;
    this.clearIdleWatch();
    this.idleCallback = null;
    return { stop: true, reason: this.stoppedReason };
  }

  isStopped(): boolean {
    return this.stoppedReason !== null;
  }

  toolSuccess(): RunGuardDecision {
    if (this.stoppedReason) return { stop: true, reason: this.stoppedReason };
    this.lastToolFailure = null;
    this.toolFailureCount = 0;
    return this.event();
  }

  toolFailure(name: string, args: unknown): RunGuardDecision {
    if (this.stoppedReason) return { stop: true, reason: this.stoppedReason };
    const signature = toolFailureSignature(name, args);
    if (signature === this.lastToolFailure) this.toolFailureCount += 1;
    else {
      this.lastToolFailure = signature;
      this.toolFailureCount = 1;
    }
    this.lastEventAt = this.now();
    this.scheduleIdleWatch();
    return this.toolFailureCount >= this.toolRetryLimit
      ? this.stop("tool_retry_loop")
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
