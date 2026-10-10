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
 * The host CPU reading behind the admission ceilings, as the server reports
 * it (mirrors `HostCpuGate` in server/src/myrmidon/run-admission.ts). `state`
 * is the verdict the admission itself would take right now.
 *
 * myrmidon(1.6.5 RUN-ADMISSION rc.3): the gate now decides on the measured
 * CPU utilisation (`cpuBusyPercent`, the non-idle share of all cores over a
 * short /proc/stat window) and, when the operator set it, the PSI cpu
 * pressure (`psiSomeAvg10`). The load-average fields stay as the auxiliary
 * reading they have become; `source` says which rule decided.
 */
export interface RuntimeLimitsHostLoad {
  state: "off" | "unknown" | "open" | "closed";
  /** The legacy load-average ceiling in percent of one core, or null when off. */
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
  /** The load-average reading above the background floor (auxiliary since rc.3). */
  loadAboveBackgroundPercent: number | null;
  /** The non-idle share of all cores, an absolute 0–100 % of the whole CPU. */
  cpuBusyPercent: number | null;
  /** The busy ceiling in percent of the whole CPU, or null when off. */
  busyThresholdPercent: number | null;
  /** The PSI cpu `some avg10` pressure, when the PSI ceiling is set. */
  psiSomeAvg10: number | null;
  /** The PSI ceiling in percent, or null when off. */
  psiThresholdPercent: number | null;
  /** Which reading decided the state: the busy/PSI ceilings or the legacy load average. */
  source: "cpu-busy" | "load-average" | null;
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
  /**
   * myrmidon(1.6.5 C0-ui): the live memory snapshot — the host's available
   * memory and the server container's cgroup usage. `null` when the server
   * does not serve it yet or cannot read it.
   */
  memory?: RuntimeLimitsMemorySnapshot | null;
}

/**
 * myrmidon(1.6.5 C0-ui): the memory snapshot the GET view ships — the host's
 * memory and the server container's cgroup usage. Each side is null when the
 * server cannot read it.
 */
export interface RuntimeLimitsMemorySnapshot {
  host: { availableMb: number; totalMb: number } | null;
  container: { limitMb: number; usedMb: number; freeMb: number } | null;
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
 * myrmidon(1.6.5 C0-ui): one line for the load screen — the host's available
 * memory against its total and the server container's cgroup usage against
 * its limit, the numbers the admission's memory floors decide on. A side the
 * server cannot read is simply not mentioned; `null` when the server sent no
 * snapshot at all, so the panel shows nothing rather than a number it made up.
 */
export function describeMemorySnapshot(
  memory: RuntimeLimitsMemorySnapshot | null | undefined,
): string | null {
  if (!memory || (!memory.host && !memory.container)) return null;
  const parts: string[] = [];
  if (memory.host) {
    parts.push(
      `Host memory: ${memory.host.availableMb.toLocaleString("en-US")} MB available of ${memory.host.totalMb.toLocaleString("en-US")} MB.`,
    );
  }
  if (memory.container) {
    parts.push(
      `Server container: ${memory.container.usedMb.toLocaleString("en-US")} MB used of ${memory.container.limitMb.toLocaleString("en-US")} MB (${memory.container.freeMb.toLocaleString("en-US")} MB free).`,
    );
  }
  return parts.join(" ");
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
 * myrmidon(1.6.5 RUN-ADMISSION rc.3): the auxiliary tail of the host line —
 * the load average the gate used to decide on, kept as a secondary reading.
 * Empty when the server sent no load-average numbers.
 */
function describeAuxiliaryLoadAverage(load: RuntimeLimitsHostLoad): string {
  if (load.loadPercentPerCore === null) return "";
  const above =
    load.loadAboveBackgroundPercent === null || load.backgroundPercentPerCore === null
      ? ""
      : `, ${load.loadAboveBackgroundPercent} % of a core above the host's background floor of ${load.backgroundPercentPerCore} %`;
  return ` Auxiliary: load average ${load.loadPercentPerCore} % of a core (load ${load.load1 ?? "?"} on ${load.cores ?? "?"} core(s))${above}.`;
}

/**
 * myrmidon(1.6.5 RUN-ADMISSION rc.2, reworked by rc.3): one line for the
 * settings page — what the host is doing right now and what that means for a
 * new run. rc.3 leads the line with the signal the gate decides on: the CPU
 * busy percent (and the PSI pressure when its ceiling is set) with its
 * threshold and verdict; the load average follows as the auxiliary reading
 * it has become. A gate that still decides on the load average (a settings
 * row saved before rc.3) keeps the old line. `null` when the server sent no
 * reading (an older server, an early request), so the panel shows nothing
 * rather than a number it made up.
 */
export function describeHostLoad(load: RuntimeLimitsHostLoad | null | undefined): string | null {
  if (!load) return null;
  if (load.state === "off") return "Ceiling is off: new runs start whatever the host load is.";
  if (load.state === "unknown") {
    return `Host load is unreadable, so the ceiling is inactive${load.reason ? `: ${load.reason}` : "."}`;
  }
  const auxiliary = describeAuxiliaryLoadAverage(load);

  if (load.source === "cpu-busy") {
    // rc.3: the measured CPU utilisation decides. The busy reading leads the
    // line with its threshold and verdict; the PSI reading joins it when the
    // operator set that ceiling; the load average is the auxiliary tail.
    const reading =
      load.cpuBusyPercent === null
        ? "Host CPU right now: busy % not measured yet (the first sample window has not elapsed)"
        : `Host CPU right now: ${load.cpuBusyPercent} % busy`;
    const psi =
      load.psiThresholdPercent === null
        ? ""
        : load.psiSomeAvg10 === null
          ? `; PSI some avg10 unreadable (ceiling ${load.psiThresholdPercent} %)`
          : `, PSI some avg10 ${load.psiSomeAvg10} % (ceiling ${load.psiThresholdPercent} %)`;
    const threshold = load.busyThresholdPercent ?? "?";
    const verdict =
      load.state === "open"
        ? `Ceiling ${threshold} % busy: open — new runs start.`
        : `Ceiling ${threshold} % busy: closed — new runs wait in the queue${load.reason ? ` (${load.reason})` : ""}.`;
    return `${reading}${psi}. ${verdict}${auxiliary}`;
  }

  // Legacy rule: a row saved before rc.3 decides on the load average — the
  // rc.2 line stands, the load average is the deciding signal here.
  if (load.loadPercentPerCore === null) {
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
