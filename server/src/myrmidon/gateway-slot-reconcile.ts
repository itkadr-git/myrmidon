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
// - Every probe/stop resolves the agent's adapterConfig secrets through the
//   same resolution path as the board's own stop (stopRemoteGatewayRun), so a
//   secret_ref apiKey works here too.
// - myrmidon(OPE-12890): the resolution is shared — one pass resolves the
//   agent's secrets at most once and hands the credentials to every probe and
//   stop of that pass (a per-probe resolution wrote one secret_access_events
//   row per secret per probe, ~20k rows/hour). Gateway runs already confirmed
//   off-gateway (probed not_found/terminal, stopped here, or recorded
//   gateway_remote_close_done in the run-close ledger) are not probed again
//   within the TTL: a gateway run id is never resurrected, so the answer
//   cannot change.

import { and, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, type Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";
import { GATEWAY_REMOTE_CLOSE_DONE_EVENT } from "./gateway-run-close.js";

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

export interface ResolvedGatewayCredentials {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string> | string | null;
}

/**
 * Sentinel passed to port calls when the reconcile pass already attempted
 * `port.resolveCredentials` and it either returned `null` or threw. Distinct
 * from `null`/`undefined` ("not attempted — legacy per-call fallback") so
 * `probeRemoteGatewayRun` / `stopRemoteGatewayRun` do not re-run
 * `resolveExecutionRunAdapterConfig` for every candidate in the pass (OPE-12890).
 */
export const GATEWAY_CREDENTIALS_UNAVAILABLE = { unavailable: true } as const;
export type GatewayCredentialsUnavailable = typeof GATEWAY_CREDENTIALS_UNAVAILABLE;
export type PassGatewayCredentials =
  | ResolvedGatewayCredentials
  | GatewayCredentialsUnavailable;

export function isGatewayCredentialsUnavailable(
  value: PassGatewayCredentials | null | undefined,
): value is GatewayCredentialsUnavailable {
  return (
    value !== null &&
    value !== undefined &&
    "unavailable" in value &&
    value.unavailable === true
  );
}

export interface GatewaySlotReconcilePort {
  /** Resolves agent adapterConfig secrets once per pass so multiple probes do not re-audit. */
  resolveCredentials?: (input: {
    companyId: string;
    agentId: string;
    adapterConfig: Record<string, unknown> | null;
  }) => Promise<ResolvedGatewayCredentials | null>;
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
    resolvedCredentials?: PassGatewayCredentials | null;
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
    resolvedCredentials?: PassGatewayCredentials | null;
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
  /** Pre-resolved gateway credentials for this agent: one secret resolution
   * (one audit event per secret) is shared by every probe and stop of the
   * pass (OPE-12890). When unset, the port's own resolveCredentials is used;
   * when that is missing too, each port call resolves on its own — the
   * pre-change behaviour. */
  resolvedCredentials?: PassGatewayCredentials | null;
}

/**
 * How long a gateway run confirmed "not on gateway" (probed not_found or
 * terminal here, or recorded `gateway_remote_close_done` in the run-close
 * ledger) stays remembered, so later passes skip its probe (OPE-12890). The
 * bound matches GATEWAY_SLOT_RECONCILE_LOOKBACK_MS: beyond it the row leaves
 * the reconcile's own lookback window anyway.
 */
export const GATEWAY_SLOT_PROBE_MEMORY_TTL_MS = GATEWAY_SLOT_RECONCILE_LOOKBACK_MS;

/**
 * myrmidon(OPE-12890): gateway runs this process has confirmed not on the
 * gateway — probed not_found or terminal, stopped here, or already recorded
 * `gateway_remote_close_done` in the run-close ledger. A gateway run id is
 * never resurrected, so a fresh probe could only return the same answer; the
 * memory saves the probe (and its secret resolution) for the TTL.
 */
const confirmedClosedGatewayRuns = new Map<string, number>();

function confirmedClosedKey(agentId: string, gatewayRunId: string): string {
  return `${agentId}:${gatewayRunId}`;
}

export function markGatewayRunConfirmedClosed(
  agentId: string,
  gatewayRunId: string,
  nowMs: number = Date.now(),
): void {
  confirmedClosedGatewayRuns.set(confirmedClosedKey(agentId, gatewayRunId), nowMs);
  // Bound the map: drop expired entries once it grows past a page.
  if (confirmedClosedGatewayRuns.size > 4096) {
    for (const [key, at] of confirmedClosedGatewayRuns) {
      if (nowMs - at > GATEWAY_SLOT_PROBE_MEMORY_TTL_MS) {
        confirmedClosedGatewayRuns.delete(key);
      }
    }
  }
}

export function isGatewayRunConfirmedClosed(
  agentId: string,
  gatewayRunId: string,
  nowMs: number = Date.now(),
): boolean {
  const recorded = confirmedClosedGatewayRuns.get(confirmedClosedKey(agentId, gatewayRunId));
  if (recorded === undefined) return false;
  if (nowMs - recorded > GATEWAY_SLOT_PROBE_MEMORY_TTL_MS) {
    confirmedClosedGatewayRuns.delete(confirmedClosedKey(agentId, gatewayRunId));
    return false;
  }
  return true;
}

export function resetGatewaySlotProbeMemoryForTest(): void {
  confirmedClosedGatewayRuns.clear();
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
  port: Pick<
    GatewaySlotReconcilePort,
    "probeGatewayRun" | "stopGatewayRunForBoard" | "resolveCredentials"
  >,
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
  const nowMs = Date.now();

  // OPE-12890: one secret resolution per pass, lazy. When the heartbeat
  // service provides resolveCredentials, its result (an audit event per
  // secret) is produced once on the first probe/stop and handed to all
  // subsequent calls. When all candidates are already remembered as
  // confirmed off-gateway, no secrets are resolved at all. If
  // resolveCredentials returns null or throws, pass GATEWAY_CREDENTIALS_UNAVAILABLE
  // so port calls do not repeat per-run secret resolution in the same pass.
  let resolvedCredentials: PassGatewayCredentials | null = options.resolvedCredentials ?? null;
  let attemptedResolve = options.resolvedCredentials != null;
  const getResolvedCredentials = async (): Promise<PassGatewayCredentials | null> => {
    if (resolvedCredentials || attemptedResolve) return resolvedCredentials;
    attemptedResolve = true;
    if (port.resolveCredentials) {
      try {
        const resolved = await port.resolveCredentials({
          companyId: agent.companyId,
          agentId: agent.id,
          adapterConfig: agent.adapterConfig,
        });
        resolvedCredentials = resolved ?? GATEWAY_CREDENTIALS_UNAVAILABLE;
      } catch (err) {
        resolvedCredentials = GATEWAY_CREDENTIALS_UNAVAILABLE;
        logger.warn(
          { err, agentId: agent.id },
          "gateway slot reconcile: shared credential resolution failed; skipping per-call secret resolution for this pass",
        );
      }
    }
    return resolvedCredentials;
  };

  for (const row of rows) {
    // A run the board still owns is never a stop candidate; it is also never
    // probed (the reattach sweep owns liveness checks for those rows).
    if (!terminal.includes(row.status)) continue;
    const gatewayRunId = row.externalRunId;
    if (!gatewayRunId) continue;

    // OPE-12890: this gateway run was already confirmed off-gateway in this
    // process (probed or closed earlier) — a fresh probe would answer the
    // same thing and only re-resolve the agent's secrets.
    if (isGatewayRunConfirmedClosed(agent.id, gatewayRunId, nowMs)) {
      result.notFound += 1;
      continue;
    }

    const creds = await getResolvedCredentials();
    let probe: Awaited<ReturnType<GatewaySlotReconcilePort["probeGatewayRun"]>>;
    try {
      probe = await port.probeGatewayRun({
        companyId: agent.companyId,
        agentId: agent.id,
        runId: row.id,
        adapterConfig: agent.adapterConfig,
        gatewayRunId,
        resolvedCredentials: creds,
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
      markGatewayRunConfirmedClosed(agent.id, gatewayRunId, nowMs);
      continue;
    }
    if (probe.state === "terminal") {
      // The gateway finished the run on its own; the slot freed by itself.
      markGatewayRunConfirmedClosed(agent.id, gatewayRunId, nowMs);
      continue;
    }
    if (probe.state === "unreachable") {
      // Best-effort: an unreachable gateway must not block run starts.
      result.unreachable += 1;
      continue;
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
        resolvedCredentials: creds,
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
        // The stop freed the slot; the gateway forgot the run.
        markGatewayRunConfirmedClosed(agent.id, gatewayRunId, nowMs);
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

  const cutoff = new Date(Date.now() - lookbackMs);
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

  // myrmidon(OPE-12890): seed this pass's probe memory from the durable
  // gateway-run-close ledger. A terminal run already recorded
  // gateway_remote_close_done was confirmed closed on the gateway (the
  // close path probed it: terminal or not_found); re-probing it each minute
  // only re-resolved the agent's secrets into secret_access_events. The
  // memory is process-local with a TTL equal to the lookback, so the ledger
  // stays the durable truth.
  const nowMs = Date.now();
  const externalIds = rows
    .filter((row) => (TERMINAL_BOARD_RUN_STATUSES as readonly string[]).includes(row.status))
    .map((row) => row.externalRunId)
    .filter((id): id is string => id !== null && !isGatewayRunConfirmedClosed(input.agentId, id, nowMs));
  if (externalIds.length > 0) {
    const closedIds = await db
      .select({ externalRunId: heartbeatRuns.externalRunId })
      .from(heartbeatRunEvents)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
      .where(
        and(
          eq(heartbeatRunEvents.runId, heartbeatRuns.id),
          eq(heartbeatRunEvents.eventType, GATEWAY_REMOTE_CLOSE_DONE_EVENT),
          eq(heartbeatRuns.agentId, input.agentId),
          inArray(heartbeatRuns.externalRunId, externalIds),
        ),
      )
      .groupBy(heartbeatRuns.externalRunId)
      .limit(externalIds.length);
    for (const closed of closedIds) {
      if (closed.externalRunId) {
        markGatewayRunConfirmedClosed(input.agentId, closed.externalRunId, nowMs);
      }
    }
  }

  return reconcileGatewaySlotsFromRows(
    { id: agentRow.id, companyId: agentRow.companyId, adapterConfig },
    rows,
    port,
    options,
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
}
