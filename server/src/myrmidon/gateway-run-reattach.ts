// server/src/myrmidon/gateway-run-reattach.ts
//
// myrmidon(HERMES-RUN-REATTACH): reattach live gateway runs after a board
// restart.
//
// The incident: the board was recreated without maintenance mode. Every
// in-flight hermes_gateway run kept running inside the bot's gateway (it owns
// the process, the board only talks HTTP), but the board had no in-process
// handle for it, so the orphan reaper marked each run "Process lost -- server
// may have restarted" and failed the agent. The gateway kept the runs in its
// max_concurrent_runs slots, the board believed the agent was free, sent a
// new run, and the gateway answered 429 -- which the board treated as a failure
// and put the agent into error.
//
// This sweep is the reattach half: for every still-`running` run of a
// hermes_gateway agent whose gateway run id was persisted on the row
// (externalRunId, written the moment the gateway admitted the run), claim the
// run and re-dispatch it through the ordinary execution path with
// contextSnapshot.reattachGatewayRunId set. The adapter then skips POST
// /v1/runs and attaches to the existing gateway run (GET /v1/runs/{id} first:
// live -> keep supervising, terminal -> read the result back, unknown -> fall
// back to an ordinary create with this attempt's own Idempotency-Key).
//
// myrmidon(T1.6, design BOARD-PROCESSES §4.3): the claim is guarded by the legacy
// controller lease. A run whose lease is still live belongs to a running
// controller -- another board process, or the previous server for the few
// seconds a hot restart overlaps it -- and stealing the lease mid-renewal
// would abort that owner ("Legacy controller lease lost"). A pass therefore
// only takes rows whose lease is absent or expired, plus rows whose controller
// boot id the caller marked adoptable: the graceful hot-restart predecessor
// recorded in the restart intent, whose process already exited and whose runs
// may be adopted without waiting out the 60s lease.
//
// Two call sites: the startup path before reapOrphanedRuns (see index.ts),
// and a periodic pass on the scheduler process. A claimed reattach execution
// registers in activeRunExecutions, so the reaper's locallyTracked check
// skips it. A run this sweep cannot claim (no externalRunId, agent gone,
// terminal status, live lease) falls through unchanged: a live-leased run is
// supervised by its owner, and once a dead owner's lease expires the periodic
// pass reattaches it before the stale-threshold reaper could finalize it.
//
// The 429 half of the incident lives in the heartbeat service: a gateway 429
// is a transient resource wait (errorFamily transient_upstream carrying the
// gateway's Retry-After), the agent stays idle instead of going to error, and
// the bounded retry follows the gateway's own hint.

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";

/** Context key carrying the gateway run id into the adapter dispatch. */
export const REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY = "reattachGatewayRunId";

/** Cadence of the periodic orphan-reattach pass (design §4.3: every 30s).
 * An expired lease is picked up within one interval, inside the reaper's
 * 5-minute stale window, so a dead executor's gateway run continues under a
 * live process instead of being finalized. */
export const GATEWAY_REATTACH_SWEEP_INTERVAL_MS = 30_000;

/** A controller boot id is a UUID; anything else never matches the uuid
 * column and must not reach an `= ANY(...)` binding as an invalid literal. */
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The narrow heartbeat surface this module uses; the full service satisfies it. */
export interface GatewayRunReattachHeartbeatPort {
  /**
   * Re-dispatch a still-running run through the ordinary execution path, with
   * the reattach marker in its context snapshot. The heartbeat service's
   * executeRun accepts `gatewayRunReattach` for exactly this.
   */
  executeRunForGatewayReattach: (
    runId: string,
    gatewayRunId: string,
  ) => Promise<void>;
}

export interface GatewayRunReattachOptions {
  /**
   * Controller boot ids whose still-live leases may be adopted anyway: the
   * graceful hot-restart predecessor recorded in the restart intent (its
   * process has already exited, so its frozen leases will never be renewed
   * and its runs can be adopted without waiting out the lease). The startup
   * pass passes this; the periodic pass does not, because a live lease there
   * means a live controller.
   */
  adoptableControllerBootIds?: readonly string[];
}

export interface GatewayRunReattachResult {
  /** Runs inspected by this pass. */
  scanned: number;
  /** Runs claimed and re-dispatched for reattach. */
  reattached: number;
  /** Runs skipped because the row already carries a reattach marker (an
   * earlier pass claimed it; the execution may still be starting). */
  skippedAlreadyMarked: number;
  /** myrmidon(T1.6): runs skipped because their legacy controller lease is
   * still live under a boot id this pass may not adopt -- the owner process
   * supervises them. */
  skippedLiveLease: number;
  /** Claim or dispatch failures; the reaper or a later pass handles them. */
  failed: number;
  runIds: string[];
}

/**
 * One pass: query and claim live here, dispatch is injected, so the claim
 * logic stays testable. Not only for startup -- the periodic tick reuses it
 * (that is why the claim is an idempotent compare-and-set on the marker):
 * a run whose controller died keeps a frozen lease until expiry, and the
 * pass that finds it expired reattaches supervision on this live process.
 */
export async function sweepGatewayRunReattach(
  db: Db,
  heartbeat: GatewayRunReattachHeartbeatPort,
  options: GatewayRunReattachOptions = {},
): Promise<GatewayRunReattachResult> {
  const adoptableBootIds = [
    ...new Set(
      (options.adoptableControllerBootIds ?? []).filter((id) =>
        BOOT_ID_PATTERN.test(id),
      ),
    ),
  ];

  const candidates = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      externalRunId: heartbeatRuns.externalRunId,
      controllerBootId: heartbeatRuns.controllerBootId,
      controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.runtimeMode, "legacy"),
        eq(agents.adapterType, "hermes_gateway"),
        isNotNull(heartbeatRuns.externalRunId),
      ),
    );

  const result: GatewayRunReattachResult = {
    scanned: candidates.length,
    reattached: 0,
    skippedAlreadyMarked: 0,
    skippedLiveLease: 0,
    failed: 0,
    runIds: [],
  };

  const nowMs = Date.now();
  const adoptableSet = new Set(adoptableBootIds);

  for (const candidate of candidates) {
    try {
      // myrmidon(T1.6): pre-filter on the row's lease so a live controller's
      // runs are never marked and the pass reports them; the claim UPDATE
      // repeats the condition atomically, because the lease may have moved
      // between the SELECT and the UPDATE (renewed, expired, or revoked).
      const leaseLive =
        candidate.controllerLeaseExpiresAt != null &&
        candidate.controllerLeaseExpiresAt.getTime() > nowMs;
      if (leaseLive && !adoptableSet.has(candidate.controllerBootId ?? "")) {
        result.skippedLiveLease += 1;
        continue;
      }

      // Atomically mark the run for reattach and claim the legacy controller
      // lease in one UPDATE: only a row that is still running, still carries
      // the gateway run id, has no reattach marker yet, and whose lease is
      // adoptable wins. The lease claim mirrors legacyControllerClaim (same
      // boot id, a fresh 60s lease, a distinct execution stage) so the
      // reaper's hasLiveLegacyController check sees a live controller while
      // the execution spins up.
      const [claimed] = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: sql`(
            coalesce(
              case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
                then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end,
              '{}'::jsonb
            )
          ) || jsonb_build_object(${REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY}::text, ${candidate.externalRunId}::text)`,
          controllerBootId: legacyControllerBootId,
          controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
          executionStage: "reattaching",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.id, candidate.id),
            eq(heartbeatRuns.companyId, candidate.companyId),
            eq(heartbeatRuns.status, "running"),
            isNotNull(heartbeatRuns.externalRunId),
            sql`coalesce((${heartbeatRuns.contextSnapshot} ->> ${REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY}), '') = ''`,
            // myrmidon(T1.6): the atomic half of the lease guard.
            or(
              isNull(heartbeatRuns.controllerLeaseExpiresAt),
              lte(
                heartbeatRuns.controllerLeaseExpiresAt,
                sql`clock_timestamp()`,
              ),
              ...(adoptableBootIds.length > 0
                ? [inArray(heartbeatRuns.controllerBootId, adoptableBootIds)]
                : []),
            ),
          ),
        )
        .returning({ id: heartbeatRuns.id });
      if (!claimed) {
        result.skippedAlreadyMarked += 1;
        continue;
      }
      await heartbeat.executeRunForGatewayReattach(
        candidate.id,
        candidate.externalRunId!,
      );
      result.reattached += 1;
      result.runIds.push(candidate.id);
    } catch (err) {
      result.failed += 1;
      logger.error(
        { err, runId: candidate.id, externalRunId: candidate.externalRunId },
        "gateway run reattach dispatch failed; the orphan reaper will finalize the run if it stays unclaimed",
      );
    }
  }

  if (result.reattached > 0) {
    logger.info(
      { ...result },
      "gateway run reattach: redispatched running gateway runs after restart",
    );
  }
  return result;
}
