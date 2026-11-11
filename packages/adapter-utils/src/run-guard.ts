import { createHash } from "node:crypto";
// myrmidon(RUN-GUARD-LOOPS): read-only/write classification of tool calls.
import { classifyToolCall } from "./myrmidon-run-guard-tools.js";

export const DEFAULT_MODEL_CALL_LIMIT = 150;
export const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_TOOL_RETRY_LIMIT = 3;
// myrmidon(RUN-GUARD-LOOPS): consecutive read-only tool calls (no write in between)
// before the run is stopped, and how many times the same read-only call may be
// made in one stretch without a write. 0 disables the check.
export const DEFAULT_NO_PROGRESS_LIMIT = 40;
export const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;
// myrmidon(OPE-12004): code-role thresholds (engineer, reviewer, lead, architect)
// give engineers room for codebase exploration (~100 reads) without false stops.
export const DEFAULT_CODE_NO_PROGRESS_LIMIT = 100;
export const DEFAULT_CODE_REPEATED_TOOL_CALL_LIMIT = 5;

export const CODE_ROLES: ReadonlySet<string> = new Set([
  "engineer",
  "reviewer",
  "lead",
  "architect",
]);

export function isCodeRole(role?: string | null): boolean {
  if (typeof role !== "string") return false;
  return CODE_ROLES.has(role.trim().toLowerCase());
}
/** Upper bound of distinct read-only call signatures remembered per run. */
const MAX_TRACKED_CALL_SIGNATURES = 2000;

// myrmidon(RUN-GUARD-LOOPS): `no_progress_exploration` and `repeated_tool_call` are new.
export const RUN_GUARD_STOP_REASONS = [
  "model_call_limit",
  "idle_timeout",
  "tool_retry_loop",
  "no_progress_exploration",
  "repeated_tool_call",
] as const;

export type RunGuardStopReason = (typeof RUN_GUARD_STOP_REASONS)[number];

export function isRunGuardStopReason(value: unknown): value is RunGuardStopReason {
  return typeof value === "string" && (RUN_GUARD_STOP_REASONS as readonly string[]).includes(value);
}

export interface RunGuardDecision {
  stop: boolean;
  reason?: RunGuardStopReason;
  hint?: {
    reason: "repeated_tool_call" | "model_call_limit";
    tool?: string;
    repeatCount?: number;
    modelCalls?: number;
  };
}

export interface RunGuardOptions {
  modelCallLimit?: number;
  idleTimeoutMs?: number;
  toolRetryLimit?: number;
  /** myrmidon(RUN-GUARD-LOOPS): 0 disables. */
  noProgressLimit?: number;
  /** myrmidon(RUN-GUARD-LOOPS): 0 disables. */
  repeatedToolCallLimit?: number;
  /** myrmidon(OPE-12004): agent role for role-based defaults. */
  role?: string | null;
  agentRole?: string | null;
  now?: () => number;
}

export interface RunGuardConfig {
  modelCallLimit?: number | null;
  idleTimeoutMs?: number | null;
  idleTimeoutSec?: number | null;
  toolRetryLimit?: number | null;
  noProgressLimit?: number | null;
  repeatedToolCallLimit?: number | null;
}

export function resolveRunGuardOptions(sources?: {
  agentConfig?: unknown;
  teamLiveness?: unknown;
  role?: string | null;
  agentRole?: string | null;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): RunGuardOptions {
  const agentObj = sources?.agentConfig && typeof sources.agentConfig === "object"
    ? (sources.agentConfig as Record<string, unknown>)
    : undefined;
  const agentGuardObj = agentObj?.runGuard && typeof agentObj.runGuard === "object"
    ? (agentObj.runGuard as Record<string, unknown>)
    : undefined;

  const teamObj = sources?.teamLiveness && typeof sources.teamLiveness === "object"
    ? (sources.teamLiveness as Record<string, unknown>)
    : undefined;
  const teamGuardObj = teamObj?.runGuard && typeof teamObj.runGuard === "object"
    ? (teamObj.runGuard as Record<string, unknown>)
    : undefined;

  const env = sources?.env ?? process.env;

  const role =
    (typeof sources?.role === "string" ? sources.role : undefined) ??
    (typeof sources?.agentRole === "string" ? sources.agentRole : undefined) ??
    (typeof agentObj?.role === "string" ? agentObj.role : undefined);

  const isCode = isCodeRole(role);
  const defaultNoProgress = isCode ? DEFAULT_CODE_NO_PROGRESS_LIMIT : DEFAULT_NO_PROGRESS_LIMIT;
  const defaultRepeated = isCode ? DEFAULT_CODE_REPEATED_TOOL_CALL_LIMIT : DEFAULT_REPEATED_TOOL_CALL_LIMIT;

  const parseNum = (val: unknown): number | undefined => {
    if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
    if (typeof val === "string") {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  };

  const modelCallLimit =
    parseNum(agentGuardObj?.modelCallLimit) ??
    parseNum(agentObj?.modelCallLimit) ??
    parseNum(teamGuardObj?.modelCallLimit) ??
    parseNum(teamObj?.modelCallLimit) ??
    parseNum(env.MYRMIDON_RUN_GUARD_MODEL_CALL_LIMIT) ??
    DEFAULT_MODEL_CALL_LIMIT;

  const idleTimeoutSec =
    parseNum(agentGuardObj?.idleTimeoutSec) ??
    parseNum(agentObj?.idleTimeoutSec) ??
    parseNum(teamGuardObj?.idleTimeoutSec) ??
    parseNum(teamObj?.idleTimeoutSec) ??
    parseNum(env.MYRMIDON_RUN_GUARD_IDLE_TIMEOUT_SEC);

  const idleTimeoutMs =
    parseNum(agentGuardObj?.idleTimeoutMs) ??
    parseNum(agentObj?.idleTimeoutMs) ??
    parseNum(teamGuardObj?.idleTimeoutMs) ??
    parseNum(teamObj?.idleTimeoutMs) ??
    (idleTimeoutSec !== undefined ? idleTimeoutSec * 1000 : undefined) ??
    parseNum(env.MYRMIDON_RUN_GUARD_IDLE_TIMEOUT_MS) ??
    DEFAULT_IDLE_TIMEOUT_MS;

  const toolRetryLimit =
    parseNum(agentGuardObj?.toolRetryLimit) ??
    parseNum(agentObj?.toolRetryLimit) ??
    parseNum(teamGuardObj?.toolRetryLimit) ??
    parseNum(teamObj?.toolRetryLimit) ??
    parseNum(env.MYRMIDON_RUN_GUARD_TOOL_RETRY_LIMIT) ??
    DEFAULT_TOOL_RETRY_LIMIT;

  // myrmidon(RUN-GUARD-LOOPS): an explicit 0 switches the check off, so these two
  // accept zero (the limits above do not).
  const parseNumOrZero = (val: unknown): number | undefined => {
    if (val === 0 || val === "0") return 0;
    return parseNum(val);
  };

  const noProgressLimit =
    parseNumOrZero(agentGuardObj?.noProgressLimit) ??
    parseNumOrZero(agentObj?.noProgressLimit) ??
    parseNumOrZero(teamGuardObj?.noProgressLimit) ??
    parseNumOrZero(teamObj?.noProgressLimit) ??
    parseNumOrZero(env.MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT) ??
    defaultNoProgress;

  const repeatedToolCallLimit =
    parseNumOrZero(agentGuardObj?.repeatedToolCallLimit) ??
    parseNumOrZero(agentObj?.repeatedToolCallLimit) ??
    parseNumOrZero(teamGuardObj?.repeatedToolCallLimit) ??
    parseNumOrZero(teamObj?.repeatedToolCallLimit) ??
    parseNumOrZero(env.MYRMIDON_RUN_GUARD_REPEATED_TOOL_CALL_LIMIT) ??
    defaultRepeated;

  return {
    modelCallLimit,
    idleTimeoutMs,
    toolRetryLimit,
    noProgressLimit,
    repeatedToolCallLimit,
    role: role ?? undefined,
    now: sources?.now,
  };
}

/**
 * Pure, adapter-neutral run circuit breaker. Callers provide already-classified
 * model/tool events; no tool arguments or provider payloads are retained.
 */
export class RunGuard {
  private readonly modelCallLimit: number;
  private readonly idleTimeoutMs: number;
  private readonly toolRetryLimit: number;
  private readonly noProgressLimit: number;
  private readonly repeatedToolCallLimit: number;
  private readonly now: () => number;
  private modelCalls = 0;
  private lastEventAt: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCallback: (() => void) | null = null;
  private idlePausedCount = 0;
  private lastToolFailure: string | null = null;
  private toolFailureCount = 0;
  // myrmidon(RUN-GUARD-LOOPS): tool calls seen, the current run of consecutive
  // read-only calls, and how often each read-only call (hash of tool + argument)
  // was made since the last write. Arguments themselves are never kept.
  // myrmidon(RUN-GUARD-CONTINUE): `writeCalls` counts the calls the classifier does
  // not take for read-only (patch, write_file, terminal commands that change
  // something, ...) over the whole run. It tells a call-limit stop of a run that
  // was changing things (work, continued by the board) from one that only looked.
  private toolCalls = 0;
  private writeCalls = 0;
  private readOnlyStreak = 0;
  private readonly readCallCounts = new Map<string, number>();
  private stoppedReason: RunGuardStopReason | null = null;
  private readonly hintedReasons = new Set<"repeated_tool_call" | "model_call_limit">();

  constructor(options: RunGuardOptions = {}) {
    const isCode = isCodeRole(options.role ?? options.agentRole);
    this.modelCallLimit = options.modelCallLimit ?? DEFAULT_MODEL_CALL_LIMIT;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.toolRetryLimit = options.toolRetryLimit ?? DEFAULT_TOOL_RETRY_LIMIT;
    this.noProgressLimit =
      options.noProgressLimit ??
      (isCode ? DEFAULT_CODE_NO_PROGRESS_LIMIT : DEFAULT_NO_PROGRESS_LIMIT);
    this.repeatedToolCallLimit =
      options.repeatedToolCallLimit ??
      (isCode ? DEFAULT_CODE_REPEATED_TOOL_CALL_LIMIT : DEFAULT_REPEATED_TOOL_CALL_LIMIT);
    this.now = options.now ?? Date.now;
    this.lastEventAt = this.now();
  }

  modelCall(): RunGuardDecision {
    if (this.stoppedReason) return { stop: true, reason: this.stoppedReason };
    if (this.modelCalls >= this.modelCallLimit) {
      const decision = this.writeCalls === 0
        ? this.hintBeforeStop({ reason: "model_call_limit", modelCalls: this.modelCalls })
        : this.stop("model_call_limit");
      if (!decision.stop) {
        this.lastEventAt = this.now();
        this.scheduleIdleWatch();
      }
      return decision;
    }
    this.modelCalls += 1;
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

  pauseIdle(): void {
    this.idlePausedCount += 1;
    this.clearIdleWatch();
  }

  resumeIdle(): void {
    this.idlePausedCount = Math.max(0, this.idlePausedCount - 1);
    if (this.idlePausedCount === 0) {
      this.lastEventAt = this.now();
      this.scheduleIdleWatch();
    }
  }

  isIdlePaused(): boolean {
    return this.idlePausedCount > 0;
  }

  private scheduleIdleWatch(): void {
    if (!this.idleCallback || this.stoppedReason || this.idlePausedCount > 0) return;
    this.clearIdleWatch();
    this.idleTimer = setTimeout(() => {
      if (this.stoppedReason || this.idlePausedCount > 0) return;
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
    if (this.stoppedReason) return { stop: true, reason: this.stoppedReason };
    if (this.idlePausedCount > 0) return { stop: false };
    return this.now() - this.lastEventAt >= this.idleTimeoutMs
      ? this.stop("idle_timeout")
      : { stop: false };
  }

  private hintBeforeStop(hint: NonNullable<RunGuardDecision["hint"]>): RunGuardDecision {
    if (this.hintedReasons.has(hint.reason)) return this.stop(hint.reason);
    this.hintedReasons.add(hint.reason);
    return { stop: false, hint };
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

  get stopped(): boolean {
    return this.stoppedReason !== null;
  }

  get stopReason(): RunGuardStopReason | null {
    return this.stoppedReason;
  }

  stats(): {
    modelCalls: number;
    modelCallCount: number;
    toolRetryCount: number;
    toolCalls: number;
    writeCalls: number;
    readOnlyStreak: number;
  } {
    return {
      modelCalls: this.modelCalls,
      modelCallCount: this.modelCalls,
      toolRetryCount: this.toolFailureCount,
      toolCalls: this.toolCalls,
      writeCalls: this.writeCalls,
      readOnlyStreak: this.readOnlyStreak,
    };
  }

  /**
   * myrmidon(RUN-GUARD-LOOPS): a tool call is about to run. Counts consecutive
   * read-only calls (reset by any write) and repeats of the same read-only call
   * (reset by any write); stops the run with `repeated_tool_call` at the
   * configured repeat limit or `no_progress_exploration` at the configured
   * streak. myrmidon(OPE-12189): the first `repeated_tool_call` trip hands back
   * a hint (`{stop:false, hint}`) instead of stopping; a second trip of the same
   * reason stops the run. Also refreshes the idle deadline, like `event()`.
   *
   * `args` is only hashed (with the tool name) and inspected for the shell
   * command of the terminal tool; nothing is retained.
   */
  toolStarted(name: string, args: unknown): RunGuardDecision {
    if (this.stoppedReason) return { stop: true, reason: this.stoppedReason };
    this.toolCalls += 1;
    if (classifyToolCall(name, args) === "write") {
      this.writeCalls += 1;
      this.readOnlyStreak = 0;
      this.readCallCounts.clear();
      return this.event();
    }
    this.readOnlyStreak += 1;
    // A call with no argument text (the gateway sometimes sends an empty preview)
    // says nothing about what was read, so it never counts as a repeat; it still
    // counts toward the read-only streak above. The tool name is part of the hash.
    if (this.repeatedToolCallLimit > 0 && !isEmptyCallArgument(args)) {
      const signature = toolFailureSignature(name, args);
      if (this.readCallCounts.size >= MAX_TRACKED_CALL_SIGNATURES && !this.readCallCounts.has(signature)) {
        this.readCallCounts.clear();
      }
      const seen = (this.readCallCounts.get(signature) ?? 0) + 1;
      this.readCallCounts.set(signature, seen);
      if (seen >= this.repeatedToolCallLimit) {
        if (this.hintedReasons.has("repeated_tool_call")) return this.stop("repeated_tool_call");
        const decision = this.hintBeforeStop({ reason: "repeated_tool_call", tool: name, repeatCount: seen });
        this.event();
        return decision;
      }
    }
    if (this.noProgressLimit > 0 && this.readOnlyStreak >= this.noProgressLimit) {
      return this.stop("no_progress_exploration");
    }
    return this.event();
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

/** No argument at all, or text that is empty or only whitespace. */
function isEmptyCallArgument(args: unknown): boolean {
  return args === undefined || args === null || (typeof args === "string" && args.trim().length === 0);
}

export function toolFailureSignature(name: string, args: unknown): string {
  return createHash("sha256").update(`${name}\0${stableJson(args)}`).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
