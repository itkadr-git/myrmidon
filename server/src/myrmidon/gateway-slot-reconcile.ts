// server/src/myrmidon/gateway-slot-reconcile.ts
//
// myrmidon(GATEWAY-SLOT-RECONCILE, OPE-11888): reconcile the Hermes gateway's
// occupied run slots against the board before a new run starts.
//
// The incident (OPE-11779): the board finalized or cancelled a heartbeat run
// while the bot gateway kept the corresponding /v1/runs run alive — its
// max_concurrent_runs slot stayed occupied. The board believed the agent was
// free, dispatched the next run, and the gateway answered 429
// "Too many concurrent runs", which burned retries and delayed the release.
//
// The Hermes gateway exposes no list-runs endpoint (its API surface is
// POST/GET /v1/runs/{id} plus stop), but the board persists every admitted
// gateway run id on the heartbeat run row (externalRunId). Reconciliation is
// therefore board-driven: probe the gateway run ids the board already owns a
// record of, and stop the ones that are still live on the gateway while the
// board considers their run terminal. That frees the leaked slot before the
// next POST /v1/runs instead of after the gateway's own timeout sweep.
//
// Safety invariants:
// - A board run that is queued, running, or scheduled_retry is NEVER stopped:
//   the board still owns it. Its gateway run may be live legitimately (the
//   reattach sweep, gateway-run-reattach.ts, supervises those rows), and a
//   live legacy controller lease is exactly the "live leased run" the task
//   forbids aborting. Such rows are counted as skippedOwned and left alone.
// - An unreachable gateway changes nothing: a slot cannot be confirmed
//   leaked, and failing the start path would turn a gateway hiccup into a
//   board outage. The reconcile is best-effort; the start proceeds.
// - Stopping is idempotent: the gateway's POST /v1/runs/{id}/stop on a run it
//   already forgot answers 404, which the adapter surfaces as
//   { stopped: false }. A repeated sweep converges without side effects.
// - myrmidon(OPE-12964): runs the pass settled (probed terminal / not_found,
//   or stopped) are remembered process-locally and never probed again within
//   the lookback. Every probe re-resolved the agent's adapterConfig secrets
//   and wrote one secret_access_events row per secret, and the same finished
//   runs were re-probed on every pass: millions of audit rows a day plus up
//   to 64 sequential gateway calls before each run start. A gateway run id is
//   never resurrected, so the answer cannot change. unreachable, live with a
//   refused stop, and thrown probes are NOT remembered; an unreachable probe
//   also ends the pass, since the remaining rows would answer the same.
// - Every probe/stop resolves the agent's adapterConfig secrets through the
//   same resolution path as the board's own stop (stopRemoteGatewayRun), so a
//   secret_ref apiKey works here too.

import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";

/**
 * Board statuses that mean "this run is over" — its gateway slot, if the
 * gateway still reports the run live, is leaked. Everything else (queued,
 * running, scheduled_retry) is still owned by the board and must never be
 * stopped from here.
 */
export const TERMINAL_BOARD_RUN_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export const OWNED_BOARD_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

/** How far back the reconcile looks for gateway run ids worth probing. A slot
 * leaked longer ago than this has been swept by the gateway's own timeout
 * (STOP_REQUEST_TIMEOUT_MS-bounded controllers, run reaper); probing ancient
 * rows would only add load. 24h matches the gateway's idempotency horizon. */
export const GATEWAY_SLOT_RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Per-agent throttle: the reconcile runs on the run-start path, so an agent
 * starting runs back-to-back must not probe its gateway on every tick. A
 * clean pass re-arms after this interval; any stop re-arms immediately
 * (cooldown 0) so the next start verifies the slot actually freed. */
export const GATEWAY_SLOT_RECONCILE_INTERVAL_MS = 60_000;

export interface GatewaySlotReconcilePort {
  /** Same shape as the heartbeat service's probeRemoteGatewayRun: resolves
   * secret_ref credentials from adapterConfig when companyId is set. */
  probeGatewayRun: (input: {
    companyId?: string;
    agentId?: string | null;
    runId?: string | null;
    adapterConfig?: Record<string, unknown> | null;
    baseUrl?: string;
    apiKey?: string | null;
    headers?: Record<string, string> | string | null;
    gatewayRunId: string;
    timeoutMs?: number;
  }) => Promise<{
    state: "live" | "terminal" | "not_found" | "unreachable";
    status: string | null;
    error?: string;
  }>;
  /** Same shape as the heartbeat service's stopRemoteGatewayRun. */
  stopGatewayRunForBoard: (input: {
    companyId: string;
    agentId: string;
    runId: string;
    adapterConfig: Record<string, unknown> | null;
    gatewayRunId: string;
    cancellation: {
      correlationId: string;
      source: { code: string; endpoint?: string; actor?: string };
      reason: string;
    };
  }) => Promise<{ stopped: boolean }>;
}

export interface GatewaySlotReconcileResult {
  /** Rows inspected (agent runs with a gateway run id in the lookback). */
  scanned: number;
  /** Gateway runs probed (terminal board rows only). */
  probed: number;
  /** Leaked slots freed: gateway reported live for a board-terminal run, and
   * the stop was accepted (or the run already terminated between probe and
   * stop). */
  stopped: number;
  /** Gateway runs still live whose board run is NOT terminal — board-owned,
   * never stopped (the reattach sweep supervises them). */
  skippedOwned: number;
  /** Settled runs skipped without a probe (OPE-12964). */
  skippedSettled?: number;
  /** Gateway already forgot the run: no slot is occupied. */
  notFound: number;
  /** Gateway unreachable (or credentials unresolvable): nothing changed. */
  unreachable: number;
  /** Probe/stop errors; the slot retries on the next pass. */
  failed: number;
  stoppedRunIds: Array<{ runId: string; gatewayRunId: string }>;
}

export interface GatewaySlotReconcileOptions {
  /** Override the lookback window (tests). */
  lookbackMs?: number;
  /** Skip the log when nothing was found (periodic noise control). */
  quiet?: boolean;
  /** Settled-run memory (OPE-12964). Defaults to none for the pure core;
   * sweepGatewaySlotsForAgent passes the process-local one. */
  settled?: { has(runId: string): boolean; add(runId: string): void };
  /** Clock override (tests). */
  nowMs?: number;
}

/**
 * myrmidon(OPE-12964): board run ids whose gateway run was confirmed off the
 * gateway by this process (probed terminal/not_found, or stop accepted), with
 * the time of confirmation. Process-local: a restart merely probes once more.
 */
const settledRunAtMs = new Map<string, number>();

function pruneSettledRuns(nowMs: number, lookbackMs: number): void {
  for (const [runId, at] of settledRunAtMs) {
    if (nowMs - at > lookbackMs) settledRunAtMs.delete(runId);
  }
}

function createSettledMemory(nowMs: number) {
  return {
    has: (runId: string) => settledRunAtMs.has(runId),
    add: (runId: string) => {
      settledRunAtMs.set(runId, nowMs);
    },
  };
}

/**
 * The pure decision core of one reconcile pass. Operates on the run rows the
 * board already holds (id, status, externalRunId) plus the agent's resolved
 * identity/config and injected gateway ports, so the claim logic — which rows
 * to probe, which to never touch, what to stop — is testable without a
 * database or a live gateway.
 */
export async function reconcileGatewaySlotsFromRows(
  agent: { id: string; companyId: string; adapterConfig: Record<string, unknown> },
  rows: ReadonlyArray<{
    id: string;
    status: string;
    externalRunId: string | null;
  }>,
  port: Pick<GatewaySlotReconcilePort, "probeGatewayRun" | "stopGatewayRunForBoard">,
  options: GatewaySlotReconcileOptions = {},
): Promise<GatewaySlotReconcileResult> {
  const result: GatewaySlotReconcileResult = {
    scanned: 0,
    probed: 0,
    stopped: 0,
    skippedOwned: 0,
    notFound: 0,
    unreachable: 0,
    failed: 0,
    stoppedRunIds: [],
  };
  result.scanned = rows.length;
  const terminal = TERMINAL_BOARD_RUN_STATUSES as readonly string[];

  for (const row of rows) {
    // A run the board still owns is never a stop candidate; it is also never
    // probed (the reattach sweep owns liveness checks for those rows).
    if (!terminal.includes(row.status)) continue;
    const gatewayRunId = row.externalRunId;
    if (!gatewayRunId) continue;
    if (options.settled?.has(row.id)) {
      result.skippedSettled = (result.skippedSettled ?? 0) + 1;
      continue;
    }

    let probe: Awaited<ReturnType<GatewaySlotReconcilePort["probeGatewayRun"]>>;
    try {
      probe = await port.probeGatewayRun({
        companyId: agent.companyId,
        agentId: agent.id,
        runId: row.id,
        adapterConfig: agent.adapterConfig,
        gatewayRunId,
      });
    } catch (err) {
      result.failed += 1;
      logger.warn(
        { err, runId: row.id, gatewayRunId, agentId: agent.id },
        "gateway slot reconcile: probe failed; slot retries on the next pass",
      );
      continue;
    }
    result.probed += 1;

    if (probe.state === "not_found") {
      result.notFound += 1;
      options.settled?.add(row.id);
      continue;
    }
    if (probe.state === "terminal") {
      // The gateway finished the run on its own; the slot freed by itself.
      options.settled?.add(row.id);
      continue;
    }
    if (probe.state === "unreachable") {
      // Best-effort: an unreachable gateway must not block run starts. The
      // remaining rows would answer the same, so end the pass (OPE-12964).
      result.unreachable += 1;
      break;
    }

    // probe.state === "live": the gateway still occupies a slot for a run the
    // board has finalized — the leak this sweep exists to close.
    try {
      const stopped = await port.stopGatewayRunForBoard({
        companyId: agent.companyId,
        agentId: agent.id,
        runId: row.id,
        adapterConfig: agent.adapterConfig,
        gatewayRunId,
        cancellation: {
          correlationId: `slot-reconcile-${row.id}`,
          source: {
            code: "gateway_slot_reconcile",
            endpoint: "startNextQueuedRunForAgent",
          },
          reason:
            "Board-run is terminal but the gateway still occupies its slot; freeing the leaked slot before the next run starts (OPE-11888)",
        },
      });
      if (stopped.stopped) {
        result.stopped += 1;
        result.stoppedRunIds.push({ runId: row.id, gatewayRunId });
        options.settled?.add(row.id);
      } else {
        // The stop did not land (404 between probe and stop, auth, network):
        // nothing more to do now; the next pass re-verifies.
        result.failed += 1;
      }
    } catch (err) {
      result.failed += 1;
      logger.warn(
        { err, runId: row.id, gatewayRunId, agentId: agent.id },
        "gateway slot reconcile: stop failed; slot retries on the next pass",
      );
    }
  }

  // skippedOwned counts the non-terminal rows in the scanned set: the board
  // still owns them, so their gateway runs (live or not) are not ours to stop.
  result.skippedOwned = rows.filter((row) => !terminal.includes(row.status)).length;

  if (!options.quiet && (result.stopped > 0 || result.failed > 0)) {
    logger.info(
      {
        agentId: agent.id,
        scanned: result.scanned,
        probed: result.probed,
        stopped: result.stopped,
        skippedOwned: result.skippedOwned,
        notFound: result.notFound,
        unreachable: result.unreachable,
        failed: result.failed,
        stoppedRunIds: result.stoppedRunIds,
      },
      `gateway slot reconcile: freed ${result.stopped} leaked slot(s), ${result.unreachable} unreachable, ${result.failed} failed out of ${result.probed} probed`,
    );
  }
  return result;
}

/**
 * One reconcile pass for one agent's gateway. The heartbeat service calls
 * this on the run-start path (startNextQueuedRunForAgent, after the queue
 * read and before admission) for hermes_gateway agents, throttled per agent.
 */
export async function sweepGatewaySlotsForAgent(
  db: Db,
  port: GatewaySlotReconcilePort,
  input: { agentId: string },
  options: GatewaySlotReconcileOptions = {},
): Promise<GatewaySlotReconcileResult> {
  const lookbackMs = options.lookbackMs ?? GATEWAY_SLOT_RECONCILE_LOOKBACK_MS;
  const nowMs = options.nowMs ?? Date.now();
  pruneSettledRuns(nowMs, lookbackMs);

  const [agentRow] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.adapterType, "hermes_gateway")))
    .limit(1);
  // Not a gateway agent (or gone): nothing to reconcile.
  if (!agentRow) {
    return {
      scanned: 0,
      probed: 0,
      stopped: 0,
      skippedOwned: 0,
      notFound: 0,
      unreachable: 0,
      failed: 0,
      stoppedRunIds: [],
    };
  }

  const adapterConfig =
    typeof agentRow.adapterConfig === "object" && agentRow.adapterConfig !== null
      ? (agentRow.adapterConfig as Record<string, unknown>)
      : {};

  const cutoff = new Date(nowMs - lookbackMs);
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      externalRunId: heartbeatRuns.externalRunId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, input.agentId),
        isNotNull(heartbeatRuns.externalRunId),
        or(
          gte(heartbeatRuns.updatedAt, cutoff),
          gte(heartbeatRuns.finishedAt, cutoff),
        ),
      ),
    )
    .orderBy(sql`${heartbeatRuns.updatedAt} desc`)
    .limit(64);

  return reconcileGatewaySlotsFromRows(
    { id: agentRow.id, companyId: agentRow.companyId, adapterConfig },
    rows,
    port,
    { ...options, settled: options.settled ?? createSettledMemory(nowMs) },
  );
}

/**
 * Per-agent throttle state for the run-start reconcile. A clean pass holds
 * for GATEWAY_SLOT_RECONCILE_INTERVAL_MS; a pass that stopped a slot (or
 * failed to reach the gateway) re-arms immediately so the very next start
 * verifies the slot freed — otherwise a leaked slot wedges one full interval
 * even after the operator fixed the gateway.
 */
const lastSweepAtByAgent = new Map<string, number>();

export function shouldReconcileGatewaySlotsForAgent(
  agentId: string,
  lastResult: Pick<GatewaySlotReconcileResult, "stopped" | "failed"> | null,
  nowMs: number = Date.now(),
): boolean {
  const last = lastSweepAtByAgent.get(agentId);
  if (last === undefined) return true;
  const interval = lastResult && (lastResult.stopped > 0 || lastResult.failed > 0) ? 0 : GATEWAY_SLOT_RECONCILE_INTERVAL_MS;
  return nowMs - last >= interval;
}

export function recordGatewaySlotSweep(agentId: string, nowMs: number = Date.now()): void {
  lastSweepAtByAgent.set(agentId, nowMs);
}

const lastSweepResultByAgent = new Map<
  string,
  Pick<GatewaySlotReconcileResult, "stopped" | "failed"> | null
>();

/**
 * Run-start entry point: run the reconcile for a gateway agent only when its
 * throttle allows, and never let a reconcile failure block the start. Returns
 * null when throttled. The heartbeat service calls this inside the agent
 * start lock, so passes for one agent are serialized; the maps are
 * process-local, which matches the sweep's best-effort contract.
 */
export async function reconcileGatewaySlotsOnRunStart(
  db: Db,
  port: GatewaySlotReconcilePort,
  agentId: string,
): Promise<GatewaySlotReconcileResult | null> {
  const lastResult = lastSweepResultByAgent.get(agentId) ?? null;
  if (!shouldReconcileGatewaySlotsForAgent(agentId, lastResult)) return null;
  let result: GatewaySlotReconcileResult;
  try {
    result = await sweepGatewaySlotsForAgent(db, port, { agentId });
  } catch (err) {
    logger.warn(
      { err, agentId },
      "gateway slot reconcile pass failed on the run-start path; run start proceeds unaffected",
    );
    result = {
      scanned: 0,
      probed: 0,
      stopped: 0,
      skippedOwned: 0,
      notFound: 0,
      unreachable: 1,
      failed: 0,
      stoppedRunIds: [],
    };
  }
  recordGatewaySlotSweep(agentId);
  lastSweepResultByAgent.set(agentId, { stopped: result.stopped, failed: result.failed });
  return result;
}

export function resetGatewaySlotReconcileThrottleForTest(): void {
  lastSweepAtByAgent.clear();
  lastSweepResultByAgent.clear();
  settledRunAtMs.clear();
}
