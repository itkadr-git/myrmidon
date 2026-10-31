// Run queue priority (myrmidon 1.6.5 RUN-PRIORITY part B): the read side of a
// queued run's waiting state and the settings side of queue priority.
//
//   GET /api/myrmidon/run-queue/position?runId=…   — position in queue + wait reason
//   GET /api/myrmidon/run-queue/priority           — the priority settings view
//   PATCH /api/myrmidon/run-queue/priority         — save it; applies without restart
//
// The endpoints are the contract of part A (OPE-5526, branch
// ope-5445-run-priority-core), which mirrors the runtime-limits pattern:
// settings live in the instance settings, the server re-reads them on every
// admission sweep (applyRunAdmissionLimits), so a saved change takes effect on
// the next pass without restarting the server. The wait reason is the same
// token the admission sweep already writes into the run's contextSnapshot
// (`waitReason`, server/src/services/heartbeat.ts); the queue rank is what
// part A adds alongside it.
//
// Everything here degrades to `null` when the server does not (yet) serve the
// endpoint — a 404/405 means "no data", never a crash and never a number the
// UI made up, so this slice ships green before part A merges and starts
// showing data the moment it does.
import { ApiError, api } from "@/api/client";

/** The wait reasons the admission can report (server/src/myrmidon/run-admission.ts + part A). */
import { RUN_WAIT_REASONS } from "./runtimeLimitsApi";

export const RUN_QUEUE_WAIT_REASONS = [
  ...RUN_WAIT_REASONS,
  // myrmidon(1.6.5 RUN-PRIORITY part A): the run waits because higher-weight
  // runs are ahead of it in the priority queue.
  "priority",
] as const;

export type RunQueueWaitReason = (typeof RUN_QUEUE_WAIT_REASONS)[number];

export function isRunQueueWaitReason(value: unknown): value is RunQueueWaitReason {
  return (
    typeof value === "string" &&
    (RUN_QUEUE_WAIT_REASONS as readonly string[]).includes(value)
  );
}

/**
 * One queued run's waiting state, as the position endpoint reports it:
 * `position` is the 1-based rank in the waiting queue, `queueLength` the total
 * of runs waiting (so the card renders "position N of M"), `waitReason` the
 * gate holding the run back (host-cpu / host-memory / priority / …), and
 * `queuedAt` since when it waits. Any field may be absent on an older server
 * or before part A lands.
 */
export interface RunQueuePosition {
  runId: string;
  position: number | null;
  queueLength: number | null;
  waitReason: string | null;
  queuedAt: string | null;
}

export interface RunQueuePositionView {
  position: RunQueuePosition | null;
}

/**
 * The queue-priority settings block part A adds to the instance settings
 * (weights by role, current-release bonus, aging), following the runtime-limits
 * shape: every value carries its source (saved here / env / default).
 */
export const RUN_PRIORITY_ROLES = ["review", "release", "lead", "engineer", "docs"] as const;
export type RunPriorityRole = (typeof RUN_PRIORITY_ROLES)[number];

export type RunPrioritySource = "settings" | "env" | "default";

export interface RunPrioritySettings {
  /** Weight per role; higher starts first. null = the role has no weight (others first). */
  roleWeights: Record<RunPriorityRole, number | null>;
  /** Bonus weight a task of the current release gets on top of its role weight. */
  currentReleaseBonus: number | null;
  /** The release tag/string tasks of the current release are matched against; "" = off. */
  currentRelease: string | null;
  /** Weight added per full aging step while a run waits queued. */
  agingStepPerHour: number | null;
  /** Cap of the aging weight added on top of the base weight. */
  agingMaxBonus: number | null;
}

export interface RunPriorityView {
  settings: RunPrioritySettings;
  /**
   * Where each served value came from. roleWeights may report one source for
   * the whole field or per role; anything the older server does not send
   * reads as "default".
   */
  sources: Partial<Record<keyof RunPrioritySettings, RunPrioritySource | Partial<Record<RunPriorityRole, RunPrioritySource>>>>;
}

export function fieldSource(view: RunPriorityView, key: Exclude<keyof RunPrioritySettings, "roleWeights">): RunPrioritySource {
  const source = view.sources?.[key];
  return source === "settings" || source === "env" ? source : "default";
}

export function roleWeightSource(view: RunPriorityView, role: RunPriorityRole): RunPrioritySource {
  const source = view.sources?.roleWeights;
  if (source === "settings" || source === "env") return source;
  if (source && typeof source === "object") {
    const perRole = source[role];
    if (perRole === "settings" || perRole === "env") return perRole;
  }
  return "default";
}

export type RunPriorityPatch = Partial<{
  roleWeights: Partial<Record<RunPriorityRole, number | null>>;
  currentReleaseBonus: number | null;
  currentRelease: string | null;
  agingStepPerHour: number | null;
  agingMaxBonus: number | null;
}>;

export const runQueuePositionQueryKey = (runId: string) =>
  ["myrmidon", "run-queue-position", runId] as const;
export const runPriorityQueryKey = ["myrmidon", "run-queue-priority"] as const;

/** True when the failure means the endpoint does not exist yet (part A not deployed). */
function isNotServed(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405);
}

export const runQueueApi = {
  /** Position + wait reason of one queued run; null when the server does not serve it. */
  async position(runId: string): Promise<RunQueuePosition | null> {
    try {
      const view = await api.get<RunQueuePositionView>(
        `/myrmidon/run-queue/position?runId=${encodeURIComponent(runId)}`,
      );
      return view?.position ?? null;
    } catch (err) {
      if (isNotServed(err)) return null;
      throw err;
    }
  },

  async priority(): Promise<RunPriorityView | null> {
    try {
      return await api.get<RunPriorityView>("/myrmidon/run-queue/priority");
    } catch (err) {
      if (isNotServed(err)) return null;
      throw err;
    }
  },

  async updatePriority(patch: RunPriorityPatch): Promise<RunPriorityView> {
    return api.patch<RunPriorityView>("/myrmidon/run-queue/priority", patch);
  },
};

/**
 * One line for the run card / queue row: "Queue position 3 of 12, waiting:
 * the host CPU ceiling is closed." Returns null when there is nothing to
 * show (no data from the server yet), so callers render no line rather than
 * a made-up one. The reason text goes through the fork catalog when a
 * translate function is provided.
 */
export function describeRunQueuePosition(
  position: RunQueuePosition | null | undefined,
  t?: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!position) return null;
  const translate = t ?? ((key: string, options?: Record<string, unknown>) =>
    interpolateFallback(key, options));
  const parts: string[] = [];
  if (position.position != null) {
    parts.push(
      position.queueLength != null
        ? translate("runQueue.position.of", { position: position.position, total: position.queueLength })
        : translate("runQueue.position.only", { position: position.position }),
    );
  }
  const reason = describeRunWaitReason(position.waitReason, translate);
  if (reason) parts.push(translate("runQueue.waiting", { reason }));
  if (parts.length === 0) return null;
  return parts.join(", ");
}

/** Human-readable wait reason; null when there is none. An unknown token shows raw. */
export function describeRunWaitReason(
  reason: string | null | undefined,
  t?: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!reason) return null;
  if (!isRunQueueWaitReason(reason)) return reason;
  const translate = t ?? ((key: string, options?: Record<string, unknown>) =>
    interpolateFallback(key, options));
  return translate(`runQueue.waitReason.${reason}`);
}

// Fallback when the caller has no catalog access (the legacy chat thread keeps
// English data strings the way it keeps the existing queueReason badges): the
// en catalog values for these keys, inlined so the helper never returns a key.
const FALLBACK_EN: Record<string, string> = {
  "runQueue.position.of": "Queue position {{position}} of {{total}}",
  "runQueue.position.only": "Queue position {{position}}",
  "runQueue.waiting": "waiting: {{reason}}",
  "runQueue.waitReason.global_cap": "the concurrency ceiling is full",
  "runQueue.waitReason.start_ramp": "the start ramp paces new starts",
  "runQueue.waitReason.memory": "the server keeps its free-memory floor",
  "runQueue.waitReason.host_memory": "the host free-memory floor is closed",
  "runQueue.waitReason.host_cpu": "the host CPU ceiling is closed",
  "runQueue.waitReason.agent_fair_share": "another agent's turn comes first (fair share)",
  "runQueue.waitReason.agent_concurrency": "the agent's own concurrency limit is full",
  "runQueue.waitReason.priority": "higher-priority runs are ahead",
};

function interpolateFallback(key: string, options?: Record<string, unknown>): string {
  let text = FALLBACK_EN[key] ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replace(new RegExp(`{{\\s*${name}\\s*}}`, "g"), String(value));
  }
  return text;
}
