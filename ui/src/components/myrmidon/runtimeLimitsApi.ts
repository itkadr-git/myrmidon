// Runtime run admission limits (myrmidon C0, RUNTIME-LIMITS):
// GET/PATCH /api/myrmidon/runtime-limits.
//
// The values cap how many agent runs this server starts at once, how fast it
// starts them, and how much memory it keeps free; PATCH saves them to the
// instance settings and they apply immediately, without restarting the server.
//
// myrmidon(1.6.5 RUN-ADMISSION rc.2): GET also carries the live host CPU
// reading the ceiling is applied to, so the settings page shows the load next
// to the field instead of only the number the operator typed.
import type { RunLimits, RunLimitsPatch, RunLimitsSource, RunLimitKey } from "@paperclipai/shared";
import { api } from "@/api/client";

/**
 * The host CPU reading behind `maxHostLoadPercentPerCore`, as the server
 * reports it (mirrors `HostCpuGate` in server/src/myrmidon/run-admission.ts).
 * `state` is the verdict the admission itself would take right now.
 */
export interface RuntimeLimitsHostLoad {
  state: "off" | "unknown" | "open" | "closed";
  thresholdPercent: number | null;
  /** Host 1-minute load average. */
  load1: number | null;
  cores: number | null;
  /** The 1-minute average in percent of one core. */
  loadPercentPerCore: number | null;
  /** The load the host carries on its own, in percent of one core. */
  backgroundPercentPerCore: number | null;
  /** The 15-minute average in percent of one core, when the file carries it. */
  load15PercentPerCore: number | null;
  /** What the ceiling actually compares: the reading above the background floor. */
  loadAboveBackgroundPercent: number | null;
  reason: string | null;
  /** ISO timestamp since when the ceiling has held runs back, or null. */
  heldSince: string | null;
}

// myrmidon(1.6.5 RUN-FAIRNESS part 3): the queue snapshot the runtime-limits
// endpoint reports next to the resolved limits — how many runs are admitted,
// the ceiling they are counted against, and the head of the waiting queue.
// `null` when the server sent no snapshot (an older server, an early
// request), so the panels show nothing rather than a number they made up.
export interface RuntimeLimitsQueueSnapshot {
  active: number;
  limit: number | null;
  queued: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgentId: string | null;
}

export interface RuntimeLimitsView {
  limits: RunLimits;
  sources: Record<RunLimitKey, RunLimitsSource>;
  hostLoad: RuntimeLimitsHostLoad | null;
  queue: RuntimeLimitsQueueSnapshot | null;
}

export const runtimeLimitsQueryKey = ["myrmidon", "runtime-limits"] as const;

export const runtimeLimitsApi = {
  get: () => api.get<RuntimeLimitsView>("/myrmidon/runtime-limits"),
  update: (patch: RunLimitsPatch) => api.patch<RuntimeLimitsView>("/myrmidon/runtime-limits", patch),
};

export function describeRunLimitSource(source: RunLimitsSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "From the server environment";
    default:
      return "Default";
  }
}

/**
 * myrmidon(1.6.5 RUN-FAIRNESS part 3): one line for the settings page — how
 * many runs are in flight against the concurrency ceiling, how many wait in
 * the queue, and since when the oldest one waits (with its agent when the
 * server names it). `null` when the server sent no snapshot, so the panel
 * shows nothing rather than a number it made up.
 */
export function describeQueueSnapshot(
  queue: RuntimeLimitsQueueSnapshot | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!queue) return null;
  const limit = queue.limit === null ? "no concurrency ceiling" : `at most ${queue.limit}`;
  const head = `Runs in flight: ${queue.active} of ${limit}.`;
  if (queue.queued === 0) return `${head} The queue is empty.`;
  const oldest = queue.oldestQueuedAt ? formatQueueSince(queue.oldestQueuedAt, now) : "an unknown time";
  const agent = queue.oldestQueuedAgentId ? ` (agent ${queue.oldestQueuedAgentId})` : "";
  return `${head} In the queue: ${queue.queued}; the oldest waits since ${oldest}${agent}.`;
}

function formatQueueSince(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an unknown time";
  const clock = at.toISOString().slice(11, 19);
  const waitedMs = now.getTime() - at.getTime();
  const waitedMin = Math.max(0, Math.floor(waitedMs / 60_000));
  return waitedMin >= 1 ? `${clock} UTC (${waitedMin} min ago)` : `${clock} UTC`;
}

/**
 * myrmidon(1.6.5 RUN-FAIRNESS part 3): the reasons a queued run can be
 * waiting (`contextSnapshot.waitReason` on the run), with the human-readable
 * English label the settings panels show next to the waiting run.
 */
export const RUN_WAIT_REASONS = [
  "global_cap",
  "start_ramp",
  "memory",
  "host_memory",
  "host_cpu",
  "agent_fair_share",
  "agent_concurrency",
] as const;

export type RunWaitReason = (typeof RUN_WAIT_REASONS)[number];

export function describeRunWaitReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "global_cap":
      return "the concurrency ceiling is full";
    case "start_ramp":
      return "the start ramp paces new starts";
    case "memory":
      return "the server keeps its free-memory floor";
    case "host_memory":
      return "the host free-memory floor is closed";
    case "host_cpu":
      return "the host CPU ceiling is closed";
    case "agent_fair_share":
      return "another agent's turn comes first (fair share)";
    case "agent_concurrency":
      return "the agent's own concurrency limit is full";
    default:
      return null;
  }
}

/**
 * myrmidon(1.6.5 RUN-ADMISSION rc.2): one line for the settings page — what the
 * host is doing right now, what part of it is the host's own background, and
 * what that means for a new run. `null` when the server sent no reading (an
 * older server, an early request), so the panel shows nothing rather than a
 * number it made up.
 */
export function describeHostLoad(load: RuntimeLimitsHostLoad | null | undefined): string | null {
  if (!load) return null;
  if (load.state === "off") return "Ceiling is off: new runs start whatever the host load is.";
  if (load.state === "unknown" || load.loadPercentPerCore === null) {
    return `Host load is unreadable, so the ceiling is inactive${load.reason ? `: ${load.reason}` : "."}`;
  }
  const reading = `Host load right now: ${load.loadPercentPerCore} % of a core (load ${load.load1 ?? "?"} on ${load.cores ?? "?"} core(s))`;
  const above =
    load.loadAboveBackgroundPercent === null || load.backgroundPercentPerCore === null
      ? ""
      : `, ${load.loadAboveBackgroundPercent} % of a core above the host's background floor of ${load.backgroundPercentPerCore} %`;
  const verdict =
    load.state === "open"
      ? `Ceiling ${load.thresholdPercent} %: open — new runs start.`
      : `Ceiling ${load.thresholdPercent} %: closed — new runs wait in the queue.`;
  return `${reading}${above}. ${verdict}`;
}