// server/src/myrmidon/bot-containers/bot-decommission.ts
//
// myrmidon(OPE-12654): the decommission sweep. An agent that leaves the bot-container runtime —
// its card moved from hermes_gateway to another adapter (omp_local, ...), or it was terminated —
// drops out of every listing that would touch its bot: the reconcile sweep, IDLE-STOP and the
// clone-report collector all select hermes_gateway + container.enabled + not terminated. Its
// container kept running for hours and its data directory stayed forever (10.11: 7 GB). This
// sweep runs inside the reconcile tick (index.ts), after the regular passes, and removes such
// bots through `driver.decommission` (dockergate A17 + A22 on the local host, fleetd's cleanup on
// a site).
//
// Which agents: `listDecommissionCandidates` (agents-query.ts) — terminated agents and agents on
// another adapter whose card has, or whose config history had, `container.enabled` on a
// hermes_gateway card. An agent the same tick reconciles is never one: a race between the two
// queries cannot decommission a bot the runtime is serving.
//
// Cost: the candidates are every agent that ever left the runtime, a list that only grows. So
// the sweep runs at most every BOT_DECOMMISSION_INTERVAL_MS (10 minutes, not every tick), and a
// bot confirmed gone (no container) is not asked again in this process until it shows up in the
// reconciled list. A candidate costs one status read (one inspect when its container is gone);
// one that still has a container, a database read and a handful of gate calls once.
//
// Safety, per bot, under the bot's lock (bot-key-lock.ts), so it never runs beside a reconcile
// pass or an "apply now" of the same bot:
//  - an agent with a run in "running" is left for a later sweep: only such a run can still be
//    executing inside the old container (a queued run starts on the agent's current adapter);
//  - the clone-hygiene report is read (the archive read works on a stopped container too). A
//    clone with unpushed work (dirty tree, operation in progress, stash, commits on no remote) or
//    one the report could not inspect holds the decommission: the data directory may be the only
//    copy of that work. A report is evidence whatever its age — a stopped container cannot have
//    pushed since it wrote it — so it is judged as of the moment it was written;
//  - a running container without a usable report holds it as well (nothing proves its clones
//    clean); a stopped one without a report is decommissioned (nothing writes there any more).
// A held bot is reported to the activity log once per reason (details.event
// "bot_decommission_held"), not on every sweep; a failure on every sweep that hits it.
//
// Never throws: a failing listing, driver or activity sink fails one sweep or one bot, not the tick.

import { botKeyForAgent } from "./agent-config.js";
import type { BotKeyLock } from "./bot-key-lock.js";
import { decideCloneFate, parseCloneReport } from "./clone-hygiene.js";
import { DECOMMISSION_UNSUPPORTED_MESSAGE, type BotContainerDriver } from "./driver.js";
import type { BotContainerActivitySink } from "./reconciler.js";

/** How often the sweep asks for candidates at most (see the module comment). */
export const BOT_DECOMMISSION_INTERVAL_MS = 10 * 60_000;

/** `details.event` of the activity entries this sweep writes (stable names for log searches). */
export const BOT_DECOMMISSIONED_EVENT = "bot_decommissioned";
export const BOT_DECOMMISSION_HELD_EVENT = "bot_decommission_held";
export const BOT_DECOMMISSION_FAILED_EVENT = "bot_decommission_failed";

/** An agent whose bot container may have outlived its place in the runtime. */
export interface BotDecommissionCandidate {
  agentId: string;
  companyId?: string;
  /** The adapter the agent is on now (hermes_gateway only for a terminated agent). */
  adapterType: string;
  /** The agent's lifecycle status. */
  status: string;
}

export type CloneReportVerdict =
  | { kind: "clean" }
  | { kind: "unpushed"; reasons: string[] }
  | { kind: "absent" };

/**
 * What a bot's clone-hygiene report (clone-hygiene.ts) says about deleting its data: `unpushed`
 * when a clone holds work that is on no remote or could not be inspected, `clean` when every
 * clone could go, `absent` when there is no usable report. The report is judged as of the moment
 * it was written: parseCloneReport drops a report older than a day for the attention signals,
 * but for an irreversible delete an old report of unpushed work is still evidence of it.
 */
export function cloneReportVerdict(raw: string | null): CloneReportVerdict {
  if (raw === null) return { kind: "absent" };
  let inspectedAtMs = Number.NaN;
  try {
    const data = JSON.parse(raw) as { inspectedAt?: unknown } | null;
    if (data && typeof data === "object" && typeof data.inspectedAt === "string") inspectedAtMs = Date.parse(data.inspectedAt);
  } catch {
    return { kind: "absent" };
  }
  if (!Number.isFinite(inspectedAtMs)) return { kind: "absent" };
  const report = parseCloneReport(raw, inspectedAtMs);
  if (!report) return { kind: "absent" };
  const reasons: string[] = [];
  for (const [clonePath, entry] of report.repos) {
    if (entry.error) {
      reasons.push(`${clonePath}: inspection failed: ${entry.error}`);
      continue;
    }
    const fate = decideCloneFate(entry, true);
    if (fate.action === "signal") reasons.push(`${clonePath}: ${fate.reason}`);
  }
  return reasons.length > 0 ? { kind: "unpushed", reasons } : { kind: "clean" };
}

export type BotDecommissionOutcome =
  | { kind: "gone" }
  | { kind: "decommissioned"; containerState: string }
  | { kind: "held"; reason: string; level: "info" | "error"; details?: Record<string, unknown> }
  | { kind: "error"; message: string };

export interface BotDecommissionDeps {
  driver: BotContainerDriver;
  lock: BotKeyLock;
  activity?: BotContainerActivitySink;
  /**
   * True when the agent has a heartbeat run in "running" (agents-query.ts agentHasRunningRun).
   * Absent: not checked. A throw holds the bot for this sweep.
   */
  hasRunningRun?: (agentId: string) => Promise<boolean>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One candidate, under its bot's lock. Never throws. */
export async function decommissionCandidate(
  candidate: BotDecommissionCandidate,
  deps: BotDecommissionDeps,
): Promise<BotDecommissionOutcome> {
  const botKey = botKeyForAgent(candidate.agentId);
  if (!botKey) return { kind: "gone" };
  const driver = deps.driver;
  if (!driver.decommission) return { kind: "error", message: DECOMMISSION_UNSUPPORTED_MESSAGE };
  try {
    return await deps.lock.run(botKey, async (): Promise<BotDecommissionOutcome> => {
      const status = await driver.status(botKey);
      if (status.state === "missing") return { kind: "gone" };
      if (deps.hasRunningRun) {
        let running: boolean;
        try {
          running = await deps.hasRunningRun(candidate.agentId);
        } catch (err) {
          return { kind: "held", level: "error", reason: "the agent's runs could not be checked", details: { error: errorMessage(err) } };
        }
        if (running) return { kind: "held", level: "info", reason: "the agent has a running heartbeat run" };
      }
      const verdict = cloneReportVerdict(driver.readCloneReport ? await driver.readCloneReport(botKey) : null);
      if (verdict.kind === "unpushed") {
        return { kind: "held", level: "error", reason: "a clone holds unpushed work", details: { clones: verdict.reasons.slice(0, 20) } };
      }
      const live = status.state === "running" || status.state === "unhealthy";
      if (live && verdict.kind === "absent") {
        return { kind: "held", level: "error", reason: "the running container has no usable clone-hygiene report" };
      }
      await driver.decommission!(botKey);
      return { kind: "decommissioned", containerState: status.state };
    });
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}

/** What one sweep remembers for the next (process-local, like the reconcile freshness stamps). */
export interface BotDecommissionSweepState {
  lastRunAtMs: number | null;
  /** Bots confirmed without a container: not asked again until they are reconciled again. */
  gone: Set<string>;
  /** The reason a bot was last held for, so a held bot is reported once per reason. */
  held: Map<string, string>;
}

export function createBotDecommissionSweepState(): BotDecommissionSweepState {
  return { lastRunAtMs: null, gone: new Set(), held: new Map() };
}

export interface BotDecommissionSweepDeps extends BotDecommissionDeps {
  listCandidates: () => Promise<BotDecommissionCandidate[]>;
  /** Defaults to BOT_DECOMMISSION_INTERVAL_MS. */
  intervalMs?: number;
  now?: () => number;
  /** The reconcile sweep was stopped: start no further bot. */
  isStopped?: () => boolean;
}

async function record(
  activity: BotContainerActivitySink | undefined,
  entry: Parameters<BotContainerActivitySink["record"]>[0],
): Promise<void> {
  try {
    await activity?.record(entry);
  } catch {
    // nothing left to report to
  }
}

/**
 * One decommission sweep, called by every reconcile tick after a successful agent listing with
 * the agents that tick reconciled; it does its work at most every `intervalMs`. Never throws.
 */
export async function runBotDecommissionSweep(
  reconciled: ReadonlyArray<{ agentId: string }>,
  deps: BotDecommissionSweepDeps,
  state: BotDecommissionSweepState,
): Promise<void> {
  try {
    // An agent the runtime reconciles again is a bot of the runtime: forget what was said about
    // it, so leaving the runtime a second time is noticed again.
    const keep = new Set(reconciled.map((agent) => agent.agentId));
    for (const agentId of keep) {
      state.gone.delete(agentId);
      state.held.delete(agentId);
    }
    const now = (deps.now ?? Date.now)();
    if (state.lastRunAtMs !== null && now - state.lastRunAtMs < (deps.intervalMs ?? BOT_DECOMMISSION_INTERVAL_MS)) return;
    state.lastRunAtMs = now;

    let candidates: BotDecommissionCandidate[];
    try {
      candidates = await deps.listCandidates();
    } catch (err) {
      await record(deps.activity, {
        level: "error",
        agentId: "*",
        botKey: "*",
        message: "bot decommission sweep failed to list its candidates",
        details: { event: BOT_DECOMMISSION_FAILED_EVENT, error: errorMessage(err) },
      });
      return;
    }

    for (const candidate of candidates) {
      if (deps.isStopped?.()) return;
      if (keep.has(candidate.agentId)) continue;
      const botKey = botKeyForAgent(candidate.agentId);
      if (!botKey || state.gone.has(botKey)) continue;
      const outcome = await decommissionCandidate(candidate, deps);
      const about = { adapterType: candidate.adapterType, agentStatus: candidate.status };
      switch (outcome.kind) {
        case "gone":
          state.gone.add(botKey);
          state.held.delete(botKey);
          break;
        case "decommissioned":
          state.gone.add(botKey);
          state.held.delete(botKey);
          await record(deps.activity, {
            level: "info",
            agentId: candidate.agentId,
            botKey,
            message: "bot container decommissioned: the agent left the bot-container runtime",
            details: { event: BOT_DECOMMISSIONED_EVENT, containerState: outcome.containerState, ...about },
          });
          break;
        case "held":
          if (state.held.get(botKey) === outcome.reason) break;
          state.held.set(botKey, outcome.reason);
          await record(deps.activity, {
            level: outcome.level,
            agentId: candidate.agentId,
            botKey,
            message: `bot decommission held: ${outcome.reason}`,
            details: { event: BOT_DECOMMISSION_HELD_EVENT, reason: outcome.reason, ...outcome.details, ...about },
          });
          break;
        case "error":
          state.held.delete(botKey);
          await record(deps.activity, {
            level: "error",
            agentId: candidate.agentId,
            botKey,
            message: "bot decommission failed",
            details: { event: BOT_DECOMMISSION_FAILED_EVENT, error: outcome.message, ...about },
          });
          break;
      }
    }
  } catch {
    // never throws: the reconcile tick goes on
  }
}
