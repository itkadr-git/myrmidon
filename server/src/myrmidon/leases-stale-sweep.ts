import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";
import type { environmentService } from "../services/environments.js";
import type { environmentRuntimeService } from "../services/environment-runtime.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { liveRunPipelineSettings } from "./runs-queue-settings/live.js";

/**
 * Stale active environment lease sweep (P1).
 *
 * A cancelled, failed or timed-out run can keep its environment lease `active`
 * when its own finalization never released it (a cancel path that skipped the
 * release, a missed teardown, a crash window). An active lease on a terminal run
 * keeps the issue busy (execution_owner_active) and defers every later wake.
 *
 * The sweep finds such leases once the run has been finished for longer than a
 * grace window, checks that the run process is really gone, tears the provider
 * sandbox down from the recorded lease data and marks the lease `expired`.
 *
 * OPE-12899: teardown retries are bounded. Every failed provider teardown claims
 * one attempt in the lease metadata (atomic guarded increment, the same shape as
 * the pending_cleanup sweep). After STALE_LEASE_TEARDOWN_ATTEMPT_CAP failed
 * attempts the sweep releases the lease with `cleanup_status = 'failed'` and
 * raises a board-owned operator attention card: the sandbox may remain on the
 * provider host. A released lease with a failed cleanup must not hold the issue
 * forever, so the conversation-continuation ownership blocker stops counting
 * released leases with a failed cleanup as a hold.
 */

export const STALE_LEASE_GRACE_ENV = "MYRMIDON_STALE_LEASE_GRACE_MS";
export const DEFAULT_STALE_LEASE_GRACE_MS = 10 * 60 * 1000;
/** The sweep inspects at most this many leases per tick. */
export const STALE_LEASE_SWEEP_PAGE_SIZE = 50;
export const STALE_LEASE_SWEEP_FAILURE_REASON = "stale_active_lease_sweep";
/** Provider teardown retries per lease before the sweep releases the lease as
 * failed and raises the operator attention card. */
export const STALE_LEASE_TEARDOWN_ATTEMPT_CAP = 3;
/** Lease metadata key carrying the claimed teardown attempt count. */
export const STALE_LEASE_TEARDOWN_ATTEMPTS_METADATA_KEY = "staleLeaseTeardownAttempts";
/** failureReason stamped on the lease released after the cap. */
export const STALE_LEASE_TEARDOWN_CAP_FAILURE_REASON = "stale_lease_teardown_cap";
/** Constant log kinds only: a teardown exception can carry credentials in its
 * message, code, cause or stack, so the sweep never reads the exception. */
export const STALE_LEASE_TEARDOWN_CAP_ERROR_KIND = "lease_teardown_cap_reached";
export const STALE_LEASE_CARD_ERROR_KIND = "lease_teardown_card_failed";

const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"];

/** Grace window in milliseconds. OPE-4096: resolves live (UI value → env
 * forced override → default); an explicit env value always wins. */
export function readStaleLeaseGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return liveRunPipelineSettings(env).staleLeaseGraceMs;
}

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type LeaseRow = typeof environmentLeases.$inferSelect;
type EnvironmentService = ReturnType<typeof environmentService>;
type EnvironmentRuntime = ReturnType<typeof environmentRuntimeService>;

/**
 * SQL reader for the claimed teardown attempt count: the metadata key must be a
 * JSON number inside a JSON object; anything else reads as 0. Clamped to
 * [0, STALE_LEASE_TEARDOWN_ATTEMPT_CAP].
 */
const staleLeaseTeardownAttemptsSql = sql`case when jsonb_typeof(metadata -> ${STALE_LEASE_TEARDOWN_ATTEMPTS_METADATA_KEY}) = 'number' then least(greatest(floor((metadata ->> ${STALE_LEASE_TEARDOWN_ATTEMPTS_METADATA_KEY})::numeric), 0), ${STALE_LEASE_TEARDOWN_ATTEMPT_CAP}::int) else 0 end`;

/**
 * SQL reader for the lease metadata root: non-object roots (the column is
 * nullable jsonb) read as '{}' so a corrupt value cannot crash the increment.
 */
const staleLeaseMetadataObjectSql = sql`case when jsonb_typeof(metadata) = 'object' then metadata else '{}'::jsonb end`;

/**
 * Atomic attempt claim. The guarded increment (status must still be `active`,
 * the stored count must still match the value this tick read) means only one
 * overlapping sweep claims an attempt, and a claimed attempt is durable before
 * the teardown call starts — a crash mid-teardown still counts against the cap.
 */
async function claimStaleLeaseTeardownAttempt(
  db: Db,
  leaseId: string,
  expectedAttempts: number,
): Promise<boolean> {
  const claimed = await db.execute(sql`update ${environmentLeases} set metadata = jsonb_set(${staleLeaseMetadataObjectSql}, array[${STALE_LEASE_TEARDOWN_ATTEMPTS_METADATA_KEY}], to_jsonb((${expectedAttempts}::int + 1)), true) where id = ${leaseId} and status = 'active' and ${staleLeaseTeardownAttemptsSql} = ${expectedAttempts}::int returning id`);
  // Row access is driver-agnostic: node-postgres wraps rows in `{ rows }`,
  // other drivers return the array directly.
  const rows = Array.isArray(claimed) ? claimed : ((claimed as { rows?: unknown[] } | null)?.rows ?? []);
  return rows.length > 0;
}

/**
 * Board-owned operator attention card for a lease the sweep gave up on. The
 * release itself always precedes this and never depends on it: a card failure
 * only loses visibility, not the unblocking.
 */
export async function raiseStaleLeaseTeardownCard(deps: {
  db: Db;
  lease: LeaseRow;
  run: { id: string };
  issueRef: string | null;
}): Promise<void> {
  if (!deps.issueRef) {
    logger.warn(
      { leaseId: deps.lease.id, runId: deps.run.id },
      "stale lease has no issue reference; skipping attention card",
    );
    return;
  }
  const service = issueRecoveryActionService(deps.db);
  await service.upsertSourceScoped({
    companyId: deps.lease.companyId,
    sourceIssueId: deps.issueRef,
    kind: "active_run_watchdog",
    ownerType: "board",
    cause: STALE_LEASE_SWEEP_FAILURE_REASON,
    fingerprint: `stale-lease-teardown:${deps.lease.id}`,
    evidence: {
      leaseId: deps.lease.id,
      environmentId: deps.lease.environmentId,
      runId: deps.run.id,
      provider: deps.lease.provider,
      providerLeaseId: deps.lease.providerLeaseId,
      attempts: STALE_LEASE_TEARDOWN_ATTEMPT_CAP,
      errorKind: STALE_LEASE_TEARDOWN_CAP_ERROR_KIND,
    },
    nextAction:
      `Teardown for sandbox lease ${deps.lease.id} failed ${STALE_LEASE_TEARDOWN_ATTEMPT_CAP} times after its run finished. ` +
      `The sandbox may still exist on the ${deps.lease.provider} host. ` +
      `Destroy it with the provider using lease ${deps.lease.providerLeaseId ?? deps.lease.id}, then retry or dismiss.`,
    wakePolicy: null,
    maxAttempts: null,
    supersedeOnIdentityChange: false,
  });
}

export interface StaleActiveLeaseSweepDeps {
  db: Db;
  environments: Pick<EnvironmentService, "getLeaseById" | "releaseLease">;
  environmentRuntime: Pick<EnvironmentRuntime, "retryPendingSandboxTeardown">;
  /** True while the run still has a live process, process group or in-server execution. */
  isRunStillActive: (run: HeartbeatRunRow) => boolean;
  /**
   * Operator attention surface for a lease released with failed cleanup after
   * the attempt cap. Injection point for tests; production wiring passes
   * raiseStaleLeaseTeardownCard.
   */
  raiseOperatorAttention?: (input: {
    lease: LeaseRow;
    run: { id: string };
    issueRef: string | null;
  }) => Promise<void>;
  /** Follow-up once a lease is released (acknowledge stop, resume deferred comments). */
  afterRelease?: (lease: LeaseRow) => Promise<void>;
}

export interface StaleActiveLeaseSweepResult {
  inspected: number;
  released: number;
  skippedAlive: number;
  failed: number;
  /** Released with cleanup_status='failed' after the teardown attempt cap. */
  capped: number;
}

export function createStaleActiveLeaseSweep(deps: StaleActiveLeaseSweepDeps) {
  return async function sweepStaleActiveEnvironmentLeases(opts?: {
    graceMs?: number;
    now?: Date;
  }): Promise<StaleActiveLeaseSweepResult> {
    const graceMs = opts?.graceMs ?? readStaleLeaseGraceMs();
    const now = opts?.now ?? new Date();
    const cutoff = new Date(now.getTime() - graceMs);
    const rows = await deps.db
      .select({
        lease: environmentLeases,
        // isRunStillActive reads the process identity columns below; the sweep
        // itself only needs id and nativeIssueId for bookkeeping.
        run: {
          id: heartbeatRuns.id,
          nativeIssueId: heartbeatRuns.nativeIssueId,
          runtimeMode: heartbeatRuns.runtimeMode,
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          nativePhase: heartbeatRuns.nativePhase,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        },
        issueRef: sql<
          string | null
        >`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot} ->> 'issueId')`,
        leaseAttempts: staleLeaseTeardownAttemptsSql,
      })
      .from(environmentLeases)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))
      .where(
        and(
          eq(environmentLeases.status, "active"),
          inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
          isNotNull(heartbeatRuns.finishedAt),
          lte(heartbeatRuns.finishedAt, cutoff),
        ),
      )
      .orderBy(asc(environmentLeases.updatedAt))
      .limit(STALE_LEASE_SWEEP_PAGE_SIZE);
    const result: StaleActiveLeaseSweepResult = { inspected: rows.length, released: 0, skippedAlive: 0, failed: 0, capped: 0 };
    for (const row of rows) {
      if (deps.isRunStillActive(row.run as HeartbeatRunRow)) {
        result.skippedAlive += 1;
        continue;
      }
      const lease = await deps.environments.getLeaseById(row.lease.id);
      if (!lease) {
        continue;
      }
      // A local lease is bookkeeping only: there is no sandbox to destroy.
      const needsProviderTeardown = !!lease.provider && lease.provider !== "local";
      if (!needsProviderTeardown) {
        await deps.environments.releaseLease(lease.id, "expired", {
          cleanupStatus: "success",
          failureReason: STALE_LEASE_SWEEP_FAILURE_REASON,
        });
        result.released += 1;
        await deps.afterRelease?.(lease);
        continue;
      }

      // Provider teardown lease. Bounded retries (OPE-12899): once the claimed
      // attempt counter reaches the cap, release the lease as failed cleanup and
      // raise the operator attention card instead of retrying forever. A
      // released lease is terminal bookkeeping; the ownership blocker no longer
      // holds the issue for it (conversation-continuation.ts).
      const claimedAttempts = Number(row.leaseAttempts ?? 0);
      if (claimedAttempts >= STALE_LEASE_TEARDOWN_ATTEMPT_CAP) {
        const released = await deps.environments.releaseLease(lease.id, "expired", {
          cleanupStatus: "failed",
          failureReason: STALE_LEASE_TEARDOWN_CAP_FAILURE_REASON,
        });
        result.capped += 1;
        logger.warn(
          {
            errorKind: STALE_LEASE_TEARDOWN_CAP_ERROR_KIND,
            leaseId: lease.id,
            runId: row.run.id,
            attempts: claimedAttempts,
          },
          "stale lease teardown cap reached; lease released with failed cleanup",
        );
        await deps
          .raiseOperatorAttention?.({
            lease,
            run: { id: row.run.id },
            issueRef: row.issueRef,
          })
          ?.catch((_: unknown) => {
            // The exception can carry provider credentials; log the constant kind only.
            logger.warn(
              { errorKind: STALE_LEASE_CARD_ERROR_KIND, leaseId: lease.id },
              "could not raise the stale lease teardown attention card",
            );
          });
        await deps.afterRelease?.(lease);
        continue;
      }

      // Claim the attempt before the teardown: an overlapping sweep cannot
      // double-teardown, and a crash mid-teardown still counts against the cap.
      const claimed = await claimStaleLeaseTeardownAttempt(deps.db, lease.id, claimedAttempts);
      if (!claimed) continue;
      try {
        const receipt = await deps.environmentRuntime.retryPendingSandboxTeardown({ environment: null, lease });
        await deps.environments.releaseLease(lease.id, "expired", {
          cleanupStatus: "success",
          failureReason: STALE_LEASE_SWEEP_FAILURE_REASON,
          remoteExecutionTermination: remoteTerminationReceipt(lease, receipt),
        });
        result.released += 1;
        await deps.afterRelease?.(lease);
      } catch {
        // The claimed attempt stays in metadata. While attempts remain below
        // the cap the lease stays active for a later tick; on the final failed
        // attempt the lease is released with failed cleanup right here, so the
        // cap never spends a tick without progress (OPE-12899). Log constant
        // errorKind values only: the exception can carry a provider credential
        // in its message, code, cause or stack.
        result.failed += 1;
        logger.warn(
          {
            errorKind: "destroy_failed",
            leaseId: lease.id,
            runId: row.run.id,
            attempts: claimedAttempts + 1,
          },
          "stale lease teardown failed",
        );
        if (claimedAttempts + 1 >= STALE_LEASE_TEARDOWN_ATTEMPT_CAP) {
          const released = await deps.environments.releaseLease(lease.id, "expired", {
            cleanupStatus: "failed",
            failureReason: STALE_LEASE_TEARDOWN_CAP_FAILURE_REASON,
          });
          result.capped += 1;
          logger.warn(
            {
              errorKind: STALE_LEASE_TEARDOWN_CAP_ERROR_KIND,
              leaseId: lease.id,
              runId: row.run.id,
              attempts: claimedAttempts + 1,
            },
            "stale lease teardown cap reached; lease released with failed cleanup",
          );
          const cappedLease = lease;
          await deps
            .raiseOperatorAttention?.({
              lease: cappedLease,
              run: { id: row.run.id },
              issueRef: row.issueRef,
            })
            ?.catch((_: unknown) => {
              // The exception can carry provider credentials; log the constant kind only.
              logger.warn(
                { errorKind: STALE_LEASE_CARD_ERROR_KIND, leaseId: lease.id },
                "could not raise the stale lease teardown attention card",
              );
            });
          await deps.afterRelease?.(cappedLease);
        }
      }
    }
    return result;
  };
}
