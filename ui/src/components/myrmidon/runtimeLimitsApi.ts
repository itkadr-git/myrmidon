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
  /** The legacy load-average ceiling in percent of one core, or null when off. */
  thresholdPercent: number | null;
  load1: number | null;
  cores: number | null;
  loadPercentPerCore: number | null;
  backgroundPercentPerCore: number | null;
  load15PercentPerCore: number | null;
  loadAboveBackgroundPercent: number | null;
  /** The non-idle share of all cores, an absolute 0-100% whole-CPU reading. */
  cpuBusyPercent: number | null;
  busyThresholdPercent: number | null;
  psiSomeAvg10: number | null;
  psiThresholdPercent: number | null;
  source: "cpu-busy" | "load-average" | null;
  reason: string | null;
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

// myrmidon(1.6.5 F-09 B): the admission's own refusals — how often a sweep pass
// left a queued run waiting because of a global or host ceiling, and the reason.
// The reasons are the admission's (`RunAdmissionDenialReason` in
// server/src/myrmidon/run-admission.ts); a reason this build does not know is
// still shown under its own name rather than dropped.
export const ADMISSION_DENIAL_REASONS = [
  "global_cap",
  "start_ramp",
  "memory",
  "host_memory",
  "host_cpu",
] as const;

export type AdmissionDenialReason = (typeof ADMISSION_DENIAL_REASONS)[number];

/**
 * myrmidon(1.6.5 F-09 B): the refusal counter the queue/limits endpoint
 * reports. Counts are the admission's own tally since the server started, so
 * the screen shows what happened, not what the current ceilings would allow.
 */
export interface RuntimeLimitsAdmissionDenials {
  /** Refusals counted since the server started. */
  total: number;
  /** How many refusals per reason; a reason with no refusal is simply absent. */
  byReason: Record<string, number>;
  /** The reason of the most recent refusal, or null when there was none. */
  lastReason: string | null;
  /** ISO timestamp of the most recent refusal, or null when there was none. */
  lastAt: string | null;
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
  /**
   * myrmidon(1.6.5 F-09 B): the admission-refusal counter. Optional on
   * purpose: an older server sends no such field, and the screen then simply
   * does not show the block (no error, no made-up zero).
   */
  admissionDenials?: RuntimeLimitsAdmissionDenials | null;
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
  // myrmidon(1.6.5 RUN-PRIORITY-PICK): the pass started the agent's more
  // important ready task first and left this run standing.
  "higher_priority_ready",
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
    case "higher_priority_ready":
      return "the agent's more important ready task goes first";
    default:
      return null;
  }
}

/**
 * myrmidon(1.6.5 F-09 B): one line for the runs-and-queue screen — how often the
 * admission refused to start a queued run because of a global or host ceiling,
 * the breakdown by reason, and when the last refusal happened. `null` when the
 * server sent no counter (an older server), so the screen shows nothing rather
 * than a zero it made up; a counter of zero is reported as "none yet".
 */
export function describeAdmissionDenials(
  denials: RuntimeLimitsAdmissionDenials | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!denials) return null;
  const total = Number.isFinite(denials.total) && denials.total > 0 ? Math.floor(denials.total) : 0;
  if (total === 0) return "Admission refusals: none yet — every queued run the sweep saw had a free slot.";
  const breakdown = describeAdmissionDenialBreakdown(denials.byReason);
  const last = describeLastAdmissionDenial(denials.lastReason, denials.lastAt, now);
  return `Admission refusals: ${total} since the server started${breakdown ? `. By reason: ${breakdown}` : ""}.${last}`;
}

/**
 * The per-reason counts, in a stable order: the largest count first, and ties in
 * the admission's own reason order. A reason this build does not know keeps its
 * raw name, so a newer server's counter is still readable. Zero counts are left
 * out — a reason that never refused is not a reason.
 */
function describeAdmissionDenialBreakdown(byReason: Record<string, number> | null | undefined): string {
  if (!byReason) return "";
  const counts = Object.entries(byReason)
    .filter(([reason, count]) => reason.length > 0 && Number.isFinite(count) && count > 0)
    .map(([reason, count]) => [reason, Math.floor(count)] as [string, number]);
  counts.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return denialReasonRank(a[0]) - denialReasonRank(b[0]);
  });
  return counts.map(([reason, count]) => `${describeDenialReasonName(reason)} x${count}`).join(", ");
}

/** The known reasons in their canonical order; an unknown one sorts last, by name. */
function denialReasonRank(reason: string): number {
  const index = (ADMISSION_DENIAL_REASONS as readonly string[]).indexOf(reason);
  return index === -1 ? ADMISSION_DENIAL_REASONS.length : index;
}

/** The server's reason word as a sentence; an unknown one is named as the server sent it. */
function describeDenialReasonName(reason: string): string {
  return describeRunWaitReason(reason) ?? `the admission refused it (${reason})`;
}

/** When the latest refusal happened and why; nothing when the server sent neither. */
function describeLastAdmissionDenial(reason: string | null | undefined, at: string | null | undefined, now: Date): string {
  const name = reason ? describeDenialReasonName(reason) : null;
  const when = at ? formatQueueSince(at, now) : null;
  if (name && when) return ` The last refusal: ${name}, at ${when}.`;
  if (name) return ` The last refusal: ${name}.`;
  if (when) return ` The last refusal was at ${when}.`;
  return "";
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
function describeAuxiliaryLoadAverage(load: RuntimeLimitsHostLoad): string {
  if (load.loadPercentPerCore === null) return " Auxiliary: load average is unreadable.";
  const background =
    load.loadAboveBackgroundPercent === null || load.backgroundPercentPerCore === null
      ? ""
      : `, ${load.loadAboveBackgroundPercent} % of a core above the background floor of ${load.backgroundPercentPerCore} %`;
  return ` Auxiliary: load average ${load.loadPercentPerCore} % of a core (load ${load.load1 ?? "?"} on ${load.cores ?? "?"} core(s)), ${load.loadAboveBackgroundPercent ?? "?"} % of a core above the host's background floor of ${load.backgroundPercentPerCore ?? "?"} %.`;
}

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
