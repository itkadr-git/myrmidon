// Run queue priority (myrmidon 1.6.5 RUN-PRIORITY part B): the read side of a
// queued run's waiting state and the settings side of queue priority.
//
//   GET /api/heartbeat-runs/:runId               — wait reason of a queued run
//   GET /api/myrmidon/run-priority               — the priority settings view
//   PATCH /api/myrmidon/run-priority             — save it; applies without restart
//
// The settings endpoints are the server core (RUN-PRIORITY A), which mirrors the runtime-limits pattern:
// settings live in the instance settings, the server re-reads them on every
// admission sweep (applyRunAdmissionLimits), so a saved change takes effect on
// the next pass without restarting the server. The waiting state is the same
// pass's view of the run, read from its contextSnapshot: `waitReason` (the gate
// holding it back, "priority" when a heavier run went first) and
// `queuePosition`/`queueLength` (its place in the priority order).
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
 * The queue-priority settings of the server core (`GET/PATCH
 * /api/myrmidon/run-priority`, packages/shared myrmidon-run-priority.ts):
 * the role sets the band and a current-release run is lifted one band above
 * the heaviest role, while the issue-priority weight, the release bonus and
 * the aging bonus only order runs *inside* their band; a run that waited past
 * the starvation limit takes the top lane. `source` says whether the stored
 * row or the environment/defaults decide.
 */
export const RUN_PRIORITY_ROLES = ["review", "release", "lead", "engineer", "docs"] as const;
export type RunPriorityRole = (typeof RUN_PRIORITY_ROLES)[number];

export type RunPrioritySource = "settings" | "env";

export interface RunPrioritySettings {
  enabled: boolean;
  /** Role key (lowercase) -> weight; a role without an entry weighs `defaultRoleWeight`. */
  roleWeights: Record<string, number>;
  defaultRoleWeight: number;
  issuePriorityWeights: Record<string, number>;
  /** The release tag that earns the bonus; null = no release bonus. */
  currentRelease: string | null;
  releaseBonus: number;
  agingStepMinutes: number;
  agingStepWeight: number;
  agingMaxBonus: number;
  starvationLimitMinutes: number;
  starvationTopWeight: number;
}

export interface RunPriorityView {
  settings: RunPrioritySettings;
  source: RunPrioritySource;
}

export function viewSource(view: RunPriorityView): RunPrioritySource {
  return view.source === "settings" ? "settings" : "env";
}

export type RunPriorityPatch = Partial<RunPrioritySettings>;

export const runQueuePositionQueryKey = (runId: string) =>
  ["myrmidon", "run-queue-position", runId] as const;
export const runPriorityQueryKey = ["myrmidon", "run-queue-priority"] as const;

/** True when the failure means the endpoint does not exist yet (part A not deployed). */
function isNotServed(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405);
}

export const runQueueApi = {
  /**
   * Waiting state of one queued run: where it waits (`queuePosition` of
   * `queueLength`, written by the priority sweep of the same pass) and why
   * (`waitReason`) read from the run's `contextSnapshot`, plus since when it
   * waits. A field the server does not publish stays null (never a number the
   * UI made up); a run that left the queue, or one the reader cannot see,
   * answers null.
   */
  async position(runId: string): Promise<RunQueuePosition | null> {
    try {
      const run = await api.get<{
        id?: string;
        status?: string;
        createdAt?: string | null;
        contextSnapshot?: Record<string, unknown> | null;
      }>(`/heartbeat-runs/${encodeURIComponent(runId)}`);
      if (!run || run.status !== "queued") return null;
      const waitReason = run.contextSnapshot?.waitReason;
      const queuePosition = run.contextSnapshot?.queuePosition;
      const queueLength = run.contextSnapshot?.queueLength;
      return {
        runId,
        position: typeof queuePosition === "number" ? queuePosition : null,
        queueLength: typeof queueLength === "number" ? queueLength : null,
        waitReason: typeof waitReason === "string" ? waitReason : null,
        queuedAt: typeof run.createdAt === "string" ? run.createdAt : null,
      };
    } catch (err) {
      if (isNotServed(err)) return null;
      throw err;
    }
  },

  async priority(): Promise<RunPriorityView | null> {
    try {
      return await api.get<RunPriorityView>("/myrmidon/run-priority");
    } catch (err) {
      if (isNotServed(err)) return null;
      throw err;
    }
  },

  async updatePriority(patch: RunPriorityPatch): Promise<RunPriorityView> {
    return api.patch<RunPriorityView>("/myrmidon/run-priority", patch);
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
  "runQueue.waitReason.higher_priority_ready": "the agent's more important ready task goes first",
};

function interpolateFallback(key: string, options?: Record<string, unknown>): string {
  let text = FALLBACK_EN[key] ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replace(new RegExp(`{{\\s*${name}\\s*}}`, "g"), String(value));
  }
  return text;
}
