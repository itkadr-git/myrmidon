// myrmidon(PR-WAIT-MONITOR, OPE-11949): a due issue monitor that waits for a
// pull request (CI checks running, review pending) must not start a full agent
// run just to look at the state of that pull request.
//
// A model run costs ~75k prompt tokens per call and ~20-30 calls, and in the
// observed week almost all such wakes ended with a "still waiting" comment. So
// the board evaluates the wait itself, from rows it already owns, with no
// GitHub call:
//
//   - the pull_request work products of the task: status (the task-pr-sync
//     sweep keeps merged/closed current), `reviewState`, and the metadata the
//     GitHub connection events write when the App delivers check events
//     (`activeCi`, `lastCompletedCi`) or the agent records (`mergeable`);
//   - the end of the agent's last run on the task, which is the last moment
//     the agent looked at the world: a fact older than that is not news.
//
// The agent is woken only for a fresh signal (CI completed, review submitted,
// merge conflict, pull request merged/closed) with the observed change handed
// over in the wake payload, or when the board has no signal at all for a
// bounded time (the safety wake: CI data may simply be missing). Otherwise the
// monitor is re-armed with a growing interval, capped, and the agent sleeps.
//
// No database access and no network here: the caller reads the rows and packs
// them into `PrWaitEvaluationInput`.

/** The shortest silent re-arm. */
export const PR_WAIT_MIN_INTERVAL_MS = 10 * 60_000;
/** The longest silent re-arm. */
export const PR_WAIT_MAX_INTERVAL_MS = 60 * 60_000;
/**
 * With no CI data for the pull request (no check events stored), the board
 * cannot tell "still running" from "finished": wake the agent once the world
 * has been quiet for this long since its last run, so a finished CI is never
 * left unnoticed.
 */
export const PR_WAIT_NO_SIGNAL_WAKE_AFTER_MS = 30 * 60_000;
/** An `activeCi` older than this was never closed by a completion event: it proves nothing. */
export const PR_WAIT_ACTIVE_CI_STALE_MS = 6 * 3_600_000;

/**
 * Words of a monitor's service name or notes that make it a wait on a pull
 * request. Generic words ("check", "review", "merge") are deliberately not
 * here: "check deploy" is not a pull-request wait.
 */
const PR_WAIT_TOKENS: ReadonlySet<string> = new Set([
  "ci",
  "checks",
  "github",
  "gh",
  "actions",
  "workflow",
  "pr",
  "pull",
]);

export interface PrWaitMonitorFacts {
  kind?: string | null;
  serviceName?: string | null;
  notes?: string | null;
  /** The hard deadline set by the agent, ISO string. */
  timeoutAt?: string | null;
}

export interface PrWaitProductFact {
  type: string;
  provider: string;
  status: string;
  reviewState?: string | null;
  url?: string | null;
  updatedAt?: Date | string | null;
  metadata?: unknown;
}

export type PrWaitSignalKind =
  | "pr_merged"
  | "pr_closed"
  | "merge_conflict"
  | "ci_completed"
  | "review_submitted";

export interface PrWaitSignal {
  kind: PrWaitSignalKind;
  pullRequest: string | null;
  headSha: string | null;
  conclusion: string | null;
  /** ISO time the fact was recorded, when the board knows it. */
  at: string | null;
}

export interface PrWaitObservedChange {
  kind: "state_changed" | "no_signal";
  summary: string;
  signals: PrWaitSignal[];
  observedAt: string;
  /** Milliseconds since the agent's last run on the task, when known. */
  quietForMs: number | null;
}

export type PrWaitDecision =
  | { action: "not_applicable"; reason: "not_a_pr_wait_monitor" | "no_pull_request" | "no_reference_point" }
  | {
      action: "defer";
      ciState: "pending" | "unknown";
      nextCheckAt: Date;
      delayMs: number;
    }
  | { action: "wake"; change: PrWaitObservedChange };

export interface PrWaitEvaluationInput {
  now: Date;
  monitor: PrWaitMonitorFacts;
  products: readonly PrWaitProductFact[];
  /**
   * When the agent last finished looking at the task (end of its last run, or
   * `now` while a run is live). Null when it never ran on the task.
   */
  agentLastLookAt: Date | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * The run context as evidence that CI of the pull request is still pending
 * (`isPendingCiForOpenPr` matches words like "CI ... pending" in it). A run
 * that a monitor woke carries the monitor's own note ("GitHub CI pending
 * monitor") in its context, so using that context re-armed the monitor after
 * every monitor run, whatever the real state of CI (one task reached 57
 * monitor attempts with no change of its pull request). Such a run is judged
 * by what the agent wrote (its last comment) and by the recorded CI marks
 * only.
 */
export function ciPendingEvidenceContext(contextSnapshot: unknown): unknown {
  return asRecord(contextSnapshot)?.wakeReason === "issue_monitor_due" ? null : contextSnapshot;
}

/** Whether a monitor's service name or notes say it waits for CI or a pull request. */
export function isPrWaitMonitor(monitor: PrWaitMonitorFacts): boolean {
  if (monitor.kind && monitor.kind !== "external_service") return false;
  const text = `${monitor.serviceName ?? ""} ${monitor.notes ?? ""}`.toLowerCase();
  return text.split(/[^a-z0-9]+/).some((token) => PR_WAIT_TOKENS.has(token));
}

function headShaOf(metadata: Record<string, unknown>): string | null {
  return (
    readString(metadata.headSha) ??
    readString(metadata.sha) ??
    readString(metadata.head_sha) ??
    readString(metadata.headRefOid) ??
    null
  )?.toLowerCase() ?? null;
}

/** Two shas name the same commit when one is a prefix of the other (short and full forms). */
function sameHead(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

function pullRequestRef(product: PrWaitProductFact, metadata: Record<string, unknown>): string | null {
  const repository = readString(metadata.repository) ?? readString(metadata.repo);
  const number = typeof metadata.number === "number" ? metadata.number : null;
  if (repository && number !== null) return `${repository}#${number}`;
  return readString(product.url);
}

function isTerminalProduct(product: PrWaitProductFact, metadata: Record<string, unknown>): "merged" | "closed" | null {
  const state = readString(metadata.state)?.toLowerCase() ?? null;
  if (product.status === "merged" || state === "merged" || metadata.merged === true) return "merged";
  if (product.status === "closed" || state === "closed") return "closed";
  return null;
}

function hasMergeConflict(metadata: Record<string, unknown>): boolean {
  const mergeable = readString(metadata.mergeable)?.toUpperCase() ?? null;
  const mergeableState = (readString(metadata.mergeableState) ?? readString(metadata.mergeStateStatus))?.toLowerCase() ?? null;
  return mergeable === "CONFLICTING" || mergeableState === "dirty";
}

/** Signals and CI knowledge read from the pull request work products of the task. */
function readProducts(products: readonly PrWaitProductFact[], now: Date) {
  const signals: PrWaitSignal[] = [];
  let pullRequests = 0;
  let ciPending = false;
  for (const product of products) {
    if (product.type !== "pull_request" || product.provider !== "github" || product.status === "archived") continue;
    pullRequests += 1;
    const metadata = asRecord(product.metadata) ?? {};
    const pullRequest = pullRequestRef(product, metadata);
    const head = headShaOf(metadata);
    const updatedAt = toDate(product.updatedAt)?.toISOString() ?? null;

    const terminal = isTerminalProduct(product, metadata);
    if (terminal) {
      signals.push({
        kind: terminal === "merged" ? "pr_merged" : "pr_closed",
        pullRequest,
        headSha: head,
        conclusion: null,
        at: toDate(metadata.mergedAt)?.toISOString() ?? updatedAt,
      });
      continue;
    }

    if (hasMergeConflict(metadata)) {
      signals.push({ kind: "merge_conflict", pullRequest, headSha: head, conclusion: null, at: updatedAt });
    }

    const completed = asRecord(metadata.lastCompletedCi);
    const completedHead = readString(completed?.headSha);
    const conclusion = readString(completed?.conclusion);
    if (completed && conclusion && sameHead(completedHead, head)) {
      signals.push({
        kind: "ci_completed",
        pullRequest,
        headSha: completedHead?.toLowerCase() ?? head,
        conclusion,
        at: toDate(completed.completedAt)?.toISOString() ?? updatedAt,
      });
    }

    const reviewState = readString(product.reviewState)?.toLowerCase() ?? null;
    if (reviewState === "approved" || reviewState === "changes_requested") {
      signals.push({ kind: "review_submitted", pullRequest, headSha: head, conclusion: reviewState, at: updatedAt });
    }

    const active = asRecord(metadata.activeCi);
    const activeStatus = readString(active?.status)?.toLowerCase() ?? null;
    if (
      active &&
      (activeStatus === "queued" || activeStatus === "in_progress" || activeStatus === "pending") &&
      sameHead(readString(active.headSha), head)
    ) {
      const observedAt = toDate(active.observedAt);
      if (!observedAt || now.getTime() - observedAt.getTime() < PR_WAIT_ACTIVE_CI_STALE_MS) ciPending = true;
    }
  }
  return { signals, pullRequests, ciPending };
}

function describeSignal(signal: PrWaitSignal): string {
  const target = signal.pullRequest ?? "pull request";
  const head = signal.headSha ? ` (head ${signal.headSha.slice(0, 8)})` : "";
  switch (signal.kind) {
    case "pr_merged":
      return `${target} was merged`;
    case "pr_closed":
      return `${target} was closed without merge`;
    case "merge_conflict":
      return `${target} has a merge conflict`;
    case "ci_completed":
      return `CI completed on ${target}${head}: ${signal.conclusion ?? "unknown conclusion"}`;
    case "review_submitted":
      return `review on ${target}: ${signal.conclusion ?? "submitted"}`;
  }
}

function nextCheckFor(input: {
  now: Date;
  agentLastLookAt: Date | null;
  timeoutAt: string | null | undefined;
  ciState: "pending" | "unknown";
}): { nextCheckAt: Date; delayMs: number } {
  const { now } = input;
  const quietMs = input.agentLastLookAt ? Math.max(0, now.getTime() - input.agentLastLookAt.getTime()) : 0;
  // The silent interval doubles with the quiet time: 10, 20, 40, 60 min.
  let delayMs = Math.min(PR_WAIT_MAX_INTERVAL_MS, Math.max(PR_WAIT_MIN_INTERVAL_MS, quietMs));
  if (input.ciState === "unknown" && input.agentLastLookAt) {
    // Land the safety wake on its threshold instead of overshooting it.
    const untilWake = input.agentLastLookAt.getTime() + PR_WAIT_NO_SIGNAL_WAKE_AFTER_MS - now.getTime();
    if (untilWake > 60_000) delayMs = Math.min(delayMs, untilWake);
  }
  let nextMs = now.getTime() + delayMs;
  // The agent's hard deadline is not postponed by a silent check.
  const deadline = toDate(input.timeoutAt);
  if (deadline && deadline.getTime() > now.getTime()) nextMs = Math.min(nextMs, deadline.getTime());
  nextMs = Math.max(nextMs, now.getTime() + 1_000);
  return { nextCheckAt: new Date(nextMs), delayMs: nextMs - now.getTime() };
}

/**
 * Decides what a due pull-request-wait monitor does: leave the agent asleep
 * and check again later (`defer`), wake it with the observed change (`wake`),
 * or stay out of it (`not_applicable`: the caller keeps the plain behaviour).
 */
export function evaluatePrWaitMonitor(input: PrWaitEvaluationInput): PrWaitDecision {
  if (!isPrWaitMonitor(input.monitor)) return { action: "not_applicable", reason: "not_a_pr_wait_monitor" };
  const { signals, pullRequests, ciPending } = readProducts(input.products, input.now);
  if (pullRequests === 0) return { action: "not_applicable", reason: "no_pull_request" };

  const lastLook = input.agentLastLookAt;
  // A fact is news when the board recorded it after the agent last looked.
  const fresh = signals.filter((signal) => {
    const at = toDate(signal.at);
    return !lastLook || !at || at.getTime() > lastLook.getTime();
  });
  if (fresh.length > 0) {
    return {
      action: "wake",
      change: {
        kind: "state_changed",
        summary: fresh.map(describeSignal).join("; "),
        signals: fresh,
        observedAt: input.now.toISOString(),
        quietForMs: lastLook ? Math.max(0, input.now.getTime() - lastLook.getTime()) : null,
      },
    };
  }

  if (ciPending) {
    return { action: "defer", ciState: "pending", ...nextCheckFor({ ...input, timeoutAt: input.monitor.timeoutAt, ciState: "pending" }) };
  }

  // No CI data and no news. Without a reference point the board cannot judge
  // how long the world has been quiet: keep the plain behaviour.
  if (!lastLook) return { action: "not_applicable", reason: "no_reference_point" };
  const quietForMs = Math.max(0, input.now.getTime() - lastLook.getTime());
  if (quietForMs >= PR_WAIT_NO_SIGNAL_WAKE_AFTER_MS) {
    const minutes = Math.round(quietForMs / 60_000);
    return {
      action: "wake",
      change: {
        kind: "no_signal",
        summary:
          `No change in the pull request state was recorded by the board for ${minutes} min, ` +
          "and it holds no check-run data for it. Verify CI and review state once, then act or re-arm the monitor.",
        signals: [],
        observedAt: input.now.toISOString(),
        quietForMs,
      },
    };
  }
  return { action: "defer", ciState: "unknown", ...nextCheckFor({ ...input, timeoutAt: input.monitor.timeoutAt, ciState: "unknown" }) };
}
