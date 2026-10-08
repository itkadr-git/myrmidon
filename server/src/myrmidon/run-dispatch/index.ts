// server/src/myrmidon/run-dispatch/index.ts
//
// myrmidon(1.6.6 RUN-DISPATCH, OPE-6443): part A of T1.4 — the run start dispatcher
// and the 30 s resweep for "queued without running".
//
// Two independent pieces live here:
//
// 1. The dispatcher (`createRunStartDispatcher`). One place that decides how a start
//    attempt is dispatched, right next to `startNextQueuedRunForAgent`:
//      inline (default) — the current process starts the queued run, exactly the
//        vendor path, unchanged, byte for byte;
//      notify — a `run_queued` goes to the process bus (design OPE-5394 section 3,
//        line 140) and the executor process starts the run. Until T1.3 (the bus)
//        lands there is nothing to publish to, so this mode records the intent in
//        the log and starts nothing here; the resweep below then picks the run up.
//
// 2. The resweep (`sweepQueuedWithoutRunning` + `startQueuedResweepTimer`). Today a
//    queued run is started synchronously from wakeups and completions, and the
//    existing resweep (`scheduleQueuedResweep`, myrmidon/run-admission.ts) is a
//    ONE-SHOT timer armed only after an admission denial. A start request that
//    never reaches the process that should start it therefore waits for the 5 min
//    scheduler tick (`resumeQueuedRuns`, index.ts). The pass here is the missing
//    fallback: every 30 s (setting `general.processes.queuedResweepSec`) take the
//    agents that have a `queued` run and NO `running` run and run
//    `startNextQueuedRunForAgent(agentId)` for each of them.
//
// The resweep starts runs on the LOCAL process whatever `runStartDispatch` says —
// that is its whole point: it is the fallback for a notification that never
// arrived, so it must not depend on the bus it is backing up. It reuses the vendor
// agent start lock and the vendor claim inside `startNextQueuedRunForAgent`, so two
// passes (or a pass racing a wakeup) cannot start the same queued run twice: the
// second attempt sees the run no longer `queued`.

import { and, asc, eq, gte, sql } from "drizzle-orm";
import { companies, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  DEFAULT_QUEUED_RESWEEP_SEC,
  loadRunDispatchSettings,
  type RunDispatchSettings,
  type RunStartDispatchMode,
} from "./settings.js";

/** An agent with at least one `queued` run and no `running` run at all. */
export interface QueuedAgentWithoutRunningRun {
  agentId: string;
  /** The oldest queued run of that agent; the pass serves the longest wait first. */
  oldestQueuedAt: Date;
}

export interface ListQueuedAgentsOptions {
  /**
   * Ignore runs created before this instant — the worktree execution cutoff. The
   * vendor queue sweep applies the same bound, and a run from a previous
   * installation must not be resurrected by this pass.
   */
  cutoff?: Date | null;
  /** Safety cap for one pass; the oldest waits come first. */
  limit?: number;
}

const DEFAULT_PASS_LIMIT = 200;

/**
 * `min(created_at)` arrives as text from the driver: an aggregate expression is not
 * a schema column, so drizzle does not run its own timestamp mapping on it. The
 * pass promises a `Date` (and the embedded-postgres suite checks it), so the
 * boundary converts — the same defensive idiom other myrmidon modules use for a
 * value whose driver type is not guaranteed.
 */
function oldestQueuedAtToDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

/**
 * The selection of the pass: agents that have a `queued` run, belong to an active
 * company and have no `running` run. Agents with a running run are skipped — the
 * vendor admission decides whether they may run one more; that is not this pass's
 * business (and a wakeup with a lost notification cannot be one of them).
 */
export async function listAgentsWithQueuedRunsAndNoRunningRun(
  db: Db,
  options: ListQueuedAgentsOptions = {},
): Promise<QueuedAgentWithoutRunningRun[]> {
  const limit = options.limit ?? DEFAULT_PASS_LIMIT;
  const rows = await db
    .select({
      agentId: heartbeatRuns.agentId,
      oldestQueuedAt: sql<string | Date>`min(${heartbeatRuns.createdAt})`.as("oldest_queued_at"),
    })
    .from(heartbeatRuns)
    .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .where(
      and(
        eq(heartbeatRuns.status, "queued"),
        eq(companies.status, "active"),
        options.cutoff ? gte(heartbeatRuns.createdAt, options.cutoff) : undefined,
        sql`not exists (
          select 1 from heartbeat_runs running
          where running.agent_id = ${heartbeatRuns.agentId}
            and running.status = 'running'
        )`,
      ),
    )
    .groupBy(heartbeatRuns.agentId)
    .orderBy(asc(sql`min(${heartbeatRuns.createdAt})`))
    .limit(limit);
  return rows.map((row) => ({
    agentId: row.agentId,
    oldestQueuedAt: oldestQueuedAtToDate(row.oldestQueuedAt),
  }));
}

export interface RunStartDispatchOptions {
  /** Fair-share hint of the vendor sweep: another agent is waiting for a slot. */
  otherAgentsWaiting?: boolean;
}

export interface QueuedResweepOutcome {
  /** Agents the pass selected: a queued run, no running run. */
  agents: number;
  /** Agents whose dispatch started at least one run. */
  started: number;
  /** Agent dispatches that threw; the rest of the pass still ran. */
  failed: number;
}

export interface RunDispatchLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
}

export interface RunStartDispatcher {
  /** The mode in force right now; re-read on every call, never cached. */
  mode: () => Promise<RunStartDispatchMode>;
  /** Dispatch one start attempt for an agent through the configured strategy. */
  dispatchRunStart: (agentId: string, options?: RunStartDispatchOptions) => Promise<unknown[]>;
  /** One resweep pass: queued without running -> startNextQueuedRunForAgent. */
  sweepQueuedWithoutRunning: () => Promise<QueuedResweepOutcome>;
}

export interface RunStartDispatcherDeps {
  /** Selection of the pass. Injected so the loop is testable without a database. */
  listQueuedAgents: (options: { cutoff: Date | null }) => Promise<QueuedAgentWithoutRunningRun[]>;
  /** The vendor start path, untouched. */
  startNextQueuedRunForAgent: (
    agentId: string,
    options?: RunStartDispatchOptions,
  ) => Promise<unknown[]>;
  /** Defaults to the stored `general.processes` reader. */
  loadSettings?: () => Promise<RunDispatchSettings>;
  /** The worktree execution cutoff, when the host has one. */
  readCutoff?: () => Promise<Date | null>;
  /**
   * myrmidon(1.6.6 RUN-DISPATCH / part B): the process bus `run_queued` publish of
   * the `notify` mode. Absent until T1.3 (the bus) lands; see `dispatchRunStart`.
   */
  requestRemoteStart?: (agentId: string) => Promise<void>;
  log?: RunDispatchLog;
}

export function createRunStartDispatcher(deps: RunStartDispatcherDeps): RunStartDispatcher {
  const loadSettings = deps.loadSettings ?? (async () => ({
    runStartDispatch: "inline" as RunStartDispatchMode,
    queuedResweepSec: DEFAULT_QUEUED_RESWEEP_SEC,
  }));

  const mode = async (): Promise<RunStartDispatchMode> =>
    (await loadSettings()).runStartDispatch;

  const dispatchRunStart = async (
    agentId: string,
    options: RunStartDispatchOptions = {},
  ): Promise<unknown[]> => {
    const { runStartDispatch } = await loadSettings();
    if (runStartDispatch === "inline") {
      // The vendor path, byte for byte: the dispatcher adds no gate, no extra
      // await and no reordering in the default mode.
      return deps.startNextQueuedRunForAgent(agentId, options);
    }
    if (deps.requestRemoteStart) {
      await deps.requestRemoteStart(agentId);
      return [];
    }
    // myrmidon(1.6.6 RUN-DISPATCH): `notify` without a bus. Starting the run here
    // would contradict the mode (an api process must not execute runs once the
    // board is split), so the attempt is published nowhere and the run stays
    // queued — the resweep below is what guarantees it starts.
    deps.log?.info?.(
      { agentId, runStartDispatch },
      "run start dispatch is 'notify' but the process bus (T1.3) is not wired yet; the queued run waits for the resweep",
    );
    return [];
  };

  const sweepQueuedWithoutRunning = async (): Promise<QueuedResweepOutcome> => {
    const cutoff = deps.readCutoff ? await deps.readCutoff() : null;
    const agents = await deps.listQueuedAgents({ cutoff });
    let started = 0;
    let failed = 0;
    for (const agent of agents) {
      try {
        const startedRuns = await deps.startNextQueuedRunForAgent(agent.agentId, {
          // The vendor sweep's fair-share hint: more than one agent is waiting.
          otherAgentsWaiting: agents.length > 1,
        });
        if (startedRuns.length > 0) started += 1;
      } catch (err) {
        failed += 1;
        deps.log?.error?.(
          { err, agentId: agent.agentId },
          "queued run resweep: start failed for agent",
        );
      }
    }
    if (agents.length > 0) {
      deps.log?.info?.(
        { agents: agents.length, started, failed },
        "queued run resweep pass (queued without running)",
      );
    }
    return { agents: agents.length, started, failed };
  };

  return { mode, dispatchRunStart, sweepQueuedWithoutRunning };
}

/** Env kill switch of the periodic resweep (ops safety valve, not a setting). */
export const QUEUED_RESWEEP_ENV = "MYRMIDON_QUEUED_RESWEEP";

export interface QueuedResweepArmDecision {
  armed: boolean;
  /** Why the pass is not armed; null when it is. */
  reason: "disabled_by_env" | "test_runner" | null;
}

/**
 * Whether this process arms the periodic resweep.
 *
 * myrmidon(1.6.6 RUN-DISPATCH): part B replaces this local gate with the role gate
 * of T1.1 (`role.executesRuns` + the background-work gate). Until then the timer is
 * a background pass inside the heartbeat service, so it stays off under a test
 * runner: the vendor suites build `heartbeatService` in-process and must keep their
 * own determinism (acceptance of part A: heartbeat/run-admission suites green with
 * no vendor-test edits). `MYRMIDON_QUEUED_RESWEEP=0` turns it off in production too.
 */
export function queuedResweepArmDecision(
  env: Record<string, string | undefined> = process.env,
): QueuedResweepArmDecision {
  const flag = (env[QUEUED_RESWEEP_ENV] ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false" || flag === "no") {
    return { armed: false, reason: "disabled_by_env" };
  }
  const vitest = (env.VITEST ?? "").trim().toLowerCase();
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "test" || (vitest !== "" && vitest !== "0" && vitest !== "false")) {
    return { armed: false, reason: "test_runner" };
  }
  return { armed: true, reason: null };
}

export interface QueuedResweepTimerInput {
  sweep: () => Promise<QueuedResweepOutcome>;
  /** Re-read per cycle, so a saved interval applies without a restart. */
  loadSettings: () => Promise<RunDispatchSettings>;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  onError?: (err: unknown) => void;
  /** Observation hook after every cycle (tests and ops). */
  onCycle?: (info: { intervalSec: number; outcome: QueuedResweepOutcome | null }) => void;
}

/**
 * Arm the periodic resweep. Self-rescheduling rather than `setInterval`, so a pass
 * never overlaps the next one and the interval can follow the setting. The timer is
 * unref'd: it never holds the process open. Returns the stop function.
 */
export function startQueuedResweepTimer(input: QueuedResweepTimerInput): () => void {
  const timers = input.timers ?? { setTimeout, clearTimeout };
  let handle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const arm = (intervalSec: number) => {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      handle = null;
      void cycle();
    }, intervalSec * 1000);
    (handle as unknown as { unref?: () => void }).unref?.();
  };

  const resolveInterval = async (): Promise<number> => {
    try {
      return (await input.loadSettings()).queuedResweepSec;
    } catch (err) {
      input.onError?.(err);
      return DEFAULT_QUEUED_RESWEEP_SEC;
    }
  };

  const cycle = async () => {
    let outcome: QueuedResweepOutcome | null = null;
    try {
      outcome = await input.sweep();
    } catch (err) {
      input.onError?.(err);
    }
    const intervalSec = await resolveInterval();
    input.onCycle?.({ intervalSec, outcome });
    arm(intervalSec);
  };

  // First wait honours the stored interval, so a configured value applies from the
  // first pass — no full default cycle before the setting is in force.
  void (async () => {
    const intervalSec = await resolveInterval();
    arm(intervalSec);
  })();

  return () => {
    stopped = true;
    if (handle) timers.clearTimeout(handle);
    handle = null;
  };
}