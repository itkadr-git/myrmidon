// server/src/myrmidon/swarm-claim/sweep.ts
//
// myrmidon(1.6-SWARM): the expired-lease sweep.
//
// This pass is what makes the acceptance criterion true: "an idle agent with a
// non-empty queue of its role cannot exist longer than one lease period". A
// lease that ran out stops covering its task, so the task is back in the
// queue — but nothing has *told* anyone that. The sweep releases the expired
// rows (making the return durable, not just implicit) and wakes the next agent
// of the task's role, on a cadence (default 30 s) far shorter than the lease
// TTL (default 15 minutes).
//
// It also releases claims whose task left the queue (closed or moved on): a
// `done` task must not occupy an agent's ceiling until its lease runs out.
//
// myrmidon(1.6.1 SWARM-IDLE-WAKE): the third pass. Releasing a lease was the
// only wake trigger; a task that was never claimed (created unassigned, or
// reassigned away) woke no one, and the free agents of the role sat idle next
// to a non-empty queue (the 03.10 fact: two ready tasks, three idle
// engineers, zero wakes). The idle pass pairs "role with a non-empty ready
// queue" with "free agents of the role" (no live claim, under the ceiling,
// not paused, no live run) and wakes the missing number, batches of at most
// MYRMIDON_SWARM_IDLE_WAKE_BATCH (default 5), each wake bound to the top task
// of the queue in claim order (critical first, oldest second). The claim
// itself still happens on the woken run's checkout — this pass only delivers
// the wake; every admission gate (pause, maintenance, limits, budget) stays
// inside enqueueWakeup.
//
// myrmidon(1.6.2 RUN-ADMISSION): the idle pass asks the host memory floor of
// the run admission first. A wake on a host below the floor only adds a run
// that waits in the queue (04.10: the idle pass and idle-pickup together had
// 23 runs going with 7 GB of host memory left, and a global OOM followed), so
// while the floor is closed the pass wakes nobody and logs why.
//
// Modelled on leases-stale-sweep.ts: one bounded page per pass, one release
// per row with the reason recorded, a best-effort wake, a failure leaves the
// row for the next pass.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { companies, agentWakeupRequests, issues, issueClaims, type Db } from "@paperclipai/db";
import { wakeNotParkedOnExecutionHold } from "../settled-holds/ready-predicate.js";
import {
  SWARM_CLAIM_IDLE_WAKE_BATCH_ENV,
  SWARM_CLAIM_CLAIMED_ACTION,
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_RELEASE_REASON_ISSUE_CLOSED,
  SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED,
  SWARM_CLAIM_RELEASED_ACTION,
  SWARM_CLAIM_WAKE_REASON,
  DEFAULT_SWARM_IDLE_WAKE_BATCH as DEFAULT_SWARM_IDLE_WAKE_BATCH_KEY,
  MAX_SWARM_IDLE_WAKE_BATCH as MAX_SWARM_IDLE_WAKE_BATCH_KEY,
  MIN_SWARM_IDLE_WAKE_BATCH as MIN_SWARM_IDLE_WAKE_BATCH_KEY,
  isSwarmLeaseExpired,
  isSwarmClaimEnabledFor,
  readSwarmIdleWakeBatchEnv,
  resolveSwarmClaimSettings,
  resolveSwarmQueueEligibility,
  type CompanyCaste,
  type SwarmClaimSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { currentHostCpuGate, currentHostMemoryGate, type HostCpuGate, type HostMemoryGate } from "../run-admission.js";
import { wakeNextAgentForIssueRole, type SwarmClaimServicePorts } from "./service.js";
import {
  assignIssueToAgentForIdleClaim,
  insertClaim,
  listClaimsOnNonQueueIssues,
  listExpiredClaims,
  releaseClaim,
  revertIdleClaimAssignment,
} from "./store.js";
import { listIdleRolePairs, liveClaimCountsByAgent } from "./idle-queue.js";
import { idleWakeTargetsForRole, idleWakeIdempotencyKey, type SwarmRoleIdleInput } from "./idle-wake.js";
import { planClaim } from "./domain.js";

/** The sweep inspects at most this many claims per pass. */
export const SWARM_CLAIM_SWEEP_PAGE_SIZE = 50;

/**
 * myrmidon(1.6.1 SWARM-IDLE-WAKE): how many agents one idle pass may wake.
 * 1.6.5 (OPE-6608 D): the value is a swarm setting now, so it is edited in the
 * interface; the variable stays as the forced override.
 */
export const SWARM_IDLE_WAKE_BATCH_ENV = SWARM_CLAIM_IDLE_WAKE_BATCH_ENV;
export const DEFAULT_SWARM_IDLE_WAKE_BATCH = DEFAULT_SWARM_IDLE_WAKE_BATCH_KEY;
export const MIN_SWARM_IDLE_WAKE_BATCH = MIN_SWARM_IDLE_WAKE_BATCH_KEY;
export const MAX_SWARM_IDLE_WAKE_BATCH = MAX_SWARM_IDLE_WAKE_BATCH_KEY;

/**
 * The idle-wake batch cap. A numeric env value in range wins; anything else
 * (unset, non-numeric, out of range) falls back to the default of 5.
 */
export function readSwarmIdleWakeBatch(env: Record<string, string | undefined>): number {
  return readSwarmIdleWakeBatchEnv(env[SWARM_IDLE_WAKE_BATCH_ENV]);
}

/** True when the environment forces the batch, i.e. the setting must not win. */
export function hasSwarmIdleWakeBatchEnvOverride(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(env[SWARM_IDLE_WAKE_BATCH_ENV]?.trim());
}

export interface SwarmClaimSweepResult {
  inspected: number;
  /** Expired leases released this pass. */
  expiredReleased: number;
  /** Leases released because their task left the queue. */
  closedReleased: number;
  /** Release attempts that threw; the row stays for the next pass. */
  failed: number;
  /** Agents woken to re-take released work. */
  woken: number;
  /** myrmidon(1.6.1 SWARM-IDLE-WAKE): free agents woken on a non-empty queue. */
  idleWoken: number;
  /**
   * 1.6.5 (OPE-6608 SWARM-WAKE-FIX A): tasks the idle pass assigned and leased
   * on the server before waking their agent — the number the acceptance
   * criterion of the ticket ("≥1 задача захвачена очередью за час") reads.
   */
  idleClaimed: number;
  /**
   * 1.6.5 (OPE-6608): assignments that lost the race (the task left the queue
   * or another claim won between the read and the write). Not an error; the
   * next pass re-reads.
   */
  idleClaimLost: number;
  /** Roles with a non-empty ready queue the idle pass examined. */
  idleRoles: number;
  /** Free agents seen at a non-empty queue (the supervisor's zero metric). */
  idleFreeAgents: number;
  /**
   * myrmidon(1.6.2 SWARM-UNASSIGNED-ROUTE): roles that have ready tasks queued
   * but no agent at all — a configuration gap (a `role:<key>` label naming a
   * caste nobody holds, or no agent of the default work role). Surfaced as a
   * warning every pass, never as silent idleness.
   */
  idleUnstaffedRoles: number;
  /**
   * myrmidon(1.6.2 RUN-ADMISSION): why the idle pass woke nobody without
   * looking at the queues — the host memory floor of the run admission was
   * closed — or null when the pass ran.
   */
  idleSkippedReason: string | null;
}

/** How often a pass skipped by the host memory floor is logged (one line per 5 min). */
const IDLE_SKIP_LOG_INTERVAL_MS = 5 * 60_000;

/** The sweeper runtime, created once per server process (see index.ts). */
export interface SwarmClaimSweeper {
  sweep(now?: Date): Promise<SwarmClaimSweepResult>;
  resetForTest(): void;
}

export interface SwarmClaimSweeperDeps extends SwarmClaimServicePorts {
  /** Minimal spacing between two passes; the scheduler ticks more often. */
  intervalMs: number;
  /**
   * myrmidon(1.6.2 RUN-ADMISSION): the host memory floor of the run
   * admission. Defaults to the process-wide admission, the same gate every
   * run start goes through; tests inject a fake.
   */
  hostMemoryGate?: () => HostMemoryGate;
  /**
   * myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling of the run
   * admission. Same rule: an idle wake is a run start by another path, so a
   * saturated host must not be piled onto. Defaults to the process-wide
   * admission; tests inject a fake.
   */
  hostCpuGate?: () => HostCpuGate;
}

export function createSwarmClaimSweeper(deps: SwarmClaimSweeperDeps): SwarmClaimSweeper {
  let lastSweepAtMs = 0;
  let lastIdleSkipLogAtMs = 0;
  const hostMemoryGate = deps.hostMemoryGate ?? currentHostMemoryGate;
  const hostCpuGate = deps.hostCpuGate ?? currentHostCpuGate;
  return {
    resetForTest() {
      lastSweepAtMs = 0;
      lastIdleSkipLogAtMs = 0;
    },
    async sweep(now = new Date()) {
      const result: SwarmClaimSweepResult = {
        inspected: 0,
        expiredReleased: 0,
        closedReleased: 0,
        failed: 0,
        woken: 0,
        idleWoken: 0,
        idleClaimed: 0,
        idleClaimLost: 0,
        idleRoles: 0,
        idleFreeAgents: 0,
        idleUnstaffedRoles: 0,
        idleSkippedReason: null,
      };
      const general = (await deps.settings.getGeneral()) as unknown as Record<string, unknown>;
      const { settings } = resolveSwarmClaimSettings({
        stored: general.swarmClaim,
        env: deps.env ?? process.env,
      });

      // 1.6.1 (SWARM-SETTINGS-UI): the interval is live. The constructed
      // `intervalMs` stays the floor (the scheduler ticks at least that often);
      // a longer stored interval spreads the passes further apart without a
      // restart, exactly like the other pilot parameters.
      const liveIntervalMs = Math.max(
        deps.intervalMs,
        settings.sweepIntervalSec * 1000,
      );
      if (now.getTime() - lastSweepAtMs < liveIntervalMs) return result;
      lastSweepAtMs = now.getTime();

      // 1.6.1 (SWARM-SETTINGS-UI): a disable leaves live leases behind — the
      // runs holding them will finish on their own, but the leases must not
      // outlive the feature. When the pilot is off (or an env override turned
      // it off after claims existed), release every live claim whose task is
      // still in the queue, with the reason recorded, then stop. This is the
      // "выключение действует сразу, текущие аренды освобождаются корректно"
      // half of the acceptance criteria; the still-queued task needs no wake
      // because vendor assignment behavior takes over.
      if (!settings.enabled) {
        if (await swarmClaimTableReachable(deps.db)) {
          const released = await releaseAllLiveClaims(deps, now, "disabled");
          result.closedReleased += released.released;
          result.failed += released.failed;
        }
        return result;
      }

      const expiredRows = await listExpiredClaims(deps.db, null, now, SWARM_CLAIM_SWEEP_PAGE_SIZE);
      const closedRows = await listClaimsOnNonQueueIssues(
        deps.db,
        null,
        [...SWARM_CLAIM_QUEUE_ISSUE_STATUSES],
        SWARM_CLAIM_SWEEP_PAGE_SIZE,
      );

      for (const row of expiredRows) {
        result.inspected += 1;
        const lease = {
          id: row.id,
          issueId: row.issueId,
          agentId: row.agentId,
          heartbeatAt: row.heartbeatAt,
          expiresAt: row.expiresAt,
          releasedAt: row.releasedAt,
        };
        if (!isSwarmLeaseExpired(lease, now)) continue;
        try {
          const released = await releaseClaim(deps.db, {
            claimId: row.id,
            reason: SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED,
            now,
          });
          if (!released) continue;
          result.expiredReleased += 1;
          await deps.logActivity?.({
            companyId: row.companyId,
            actorType: "system",
            actorId: "swarm_claim_sweep",
            agentId: row.agentId,
            runId: row.runId,
            action: SWARM_CLAIM_RELEASED_ACTION,
            entityType: "issue",
            entityId: row.issueId,
            details: { reason: SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED, claimId: row.id },
          });
          // Best-effort wake: the queue itself still holds the task even when
          // the wake is deferred, and the next pass tries again.
          const woke = await wakeNextAgentForIssueRole(deps, {
            companyId: row.companyId,
            issueId: row.issueId,
            excludeAgentId: row.agentId,
            idempotencySuffix: "sweep",
            now,
          }).catch(() => false);
          if (woke) result.woken += 1;
        } catch {
          result.failed += 1;
          logger.warn(
            { claimId: row.id, issueId: row.issueId },
            "swarm claim sweep release failed; the row stays for the next pass",
          );
        }
      }

      for (const row of closedRows) {
        result.inspected += 1;
        try {
          const released = await releaseClaim(deps.db, {
            claimId: row.id,
            reason: SWARM_CLAIM_RELEASE_REASON_ISSUE_CLOSED,
            now,
          });
          if (released) result.closedReleased += 1;
        } catch {
          result.failed += 1;
        }
      }

      // myrmidon(1.6.1 SWARM-IDLE-WAKE): the idle pass. Runs after the
      // release passes so this tick's releases are already back in the queue
      // the pair read sees. One company at a time, bounded by the batch cap.
      // myrmidon(1.6.2 RUN-ADMISSION): no idle wakes while the host floor is
      // closed. An unreadable host ("unknown") does not block: the floor is
      // inactive then, exactly as it is for the run starts themselves.
      const gate = hostMemoryGate();
      if (gate.state === "closed") {
        result.idleSkippedReason = gate.reason ?? "host free memory is below the run admission floor";
        if (now.getTime() - lastIdleSkipLogAtMs >= IDLE_SKIP_LOG_INTERVAL_MS) {
          lastIdleSkipLogAtMs = now.getTime();
          logger.warn(
            {
              availableMb: gate.availableMb,
              thresholdMb: gate.thresholdMb,
              settlingRuns: gate.settlingRuns,
              reason: result.idleSkippedReason,
            },
            "swarm idle wake pass skipped: the run admission host memory floor is closed",
          );
        }
        return result;
      }
      // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling. The 05.10
      // incident was exactly this pass waking agents onto a host whose memory
      // looked fine while its load average ran at 594 % of a core per core.
      const cpuGate = hostCpuGate();
      if (cpuGate.state === "closed") {
        result.idleSkippedReason = cpuGate.reason ?? "host CPU load is at or above the run admission ceiling";
        if (now.getTime() - lastIdleSkipLogAtMs >= IDLE_SKIP_LOG_INTERVAL_MS) {
          lastIdleSkipLogAtMs = now.getTime();
          logger.warn(
            {
              load1: cpuGate.load1,
              cores: cpuGate.cores,
              loadPercentPerCore: cpuGate.loadPercentPerCore,
              // myrmidon(1.6.5 rc.2): the ceiling is measured above the host's
              // own background load, so both numbers go to the log.
              backgroundPercentPerCore: cpuGate.backgroundPercentPerCore,
              loadAboveBackgroundPercent: cpuGate.loadAboveBackgroundPercent,
              thresholdPercent: cpuGate.thresholdPercent,
              reason: result.idleSkippedReason,
            },
            "swarm idle wake pass skipped: the run admission host CPU ceiling is closed",
          );
        }
        return result;
      }
      try {
        const idle = await sweepIdleWakes(deps, { settings, now, result });
        if (idle.idleWoken > 0) {
          logger.warn(
            {
              idleWoken: idle.idleWoken,
              idleRoles: idle.idleRoles,
              idleFreeAgents: idle.idleFreeAgents,
            },
            "swarm idle wake pass woke free agents on a non-empty role queue",
          );
        }
      } catch {
        // CONSTANT errorKind only (the exception can carry a credential).
        logger.warn(
          { errorKind: "swarm_idle_wake_failed" },
          "swarm idle wake pass failed; the next tick retries",
        );
      }
      return result;
    },
  };
}

/**
 * 1.6.1 (SWARM-SETTINGS-UI): true when the claim table can be read at all —
 * the disable path probes it the same cheap way the supervisor view does, so
 * an instance without the table (part A never merged) skips the release pass.
 */
async function swarmClaimTableReachable(db: Db): Promise<boolean> {
  const { swarmClaimTableReady } = await import("./store.js");
  return swarmClaimTableReady(db);
}

/** The release reason written when a disable frees a live lease. */
export const SWARM_CLAIM_RELEASE_REASON_DISABLED = "pilot_disabled";

/**
 * 1.6.1 (SWARM-SETTINGS-UI): release every live claim, one bounded page per
 * pass. Bounded on purpose: a huge claim table empties over a few passes of
 * the sweep instead of one long transaction, and each release is its own row
 * write with its own activity entry, exactly like the expiry path.
 */
async function releaseAllLiveClaims(
  deps: SwarmClaimSweeperDeps,
  now: Date,
  _why: string,
): Promise<{ released: number; failed: number }> {
  const { listAllLiveClaims, releaseClaim } = await import("./store.js");
  let released = 0;
  let failed = 0;
  const rows = await listAllLiveClaims(deps.db, SWARM_CLAIM_SWEEP_PAGE_SIZE);
  for (const row of rows) {
    try {
      const ok = await releaseClaim(deps.db, {
        claimId: row.id,
        reason: SWARM_CLAIM_RELEASE_REASON_DISABLED,
        now,
      });
      if (!ok) continue;
      released += 1;
      await deps.logActivity?.({
        companyId: row.companyId,
        actorType: "system",
        actorId: "swarm_claim_sweep",
        agentId: row.agentId,
        runId: row.runId,
        action: SWARM_CLAIM_RELEASED_ACTION,
        entityType: "issue",
        entityId: row.issueId,
        details: { reason: SWARM_CLAIM_RELEASE_REASON_DISABLED, claimId: row.id },
      });
    } catch {
      failed += 1;
    }
  }
  return { released, failed };
}

/** The companies the idle pass visits: active ones only, bounded page. */
export async function listActiveCompanies(db: Db, limit = 50): Promise<string[]> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"))
    .limit(limit);
  return rows.map((row) => row.id);
}

async function sweepIdleWakes(
  deps: SwarmClaimServicePorts & { db: Db },
  input: {
    settings: Pick<
      SwarmClaimSettings,
      | "enabled"
      | "enabledCompanyIds"
      | "enabledRoles"
      | "maxActiveTasks"
      | "p0Preemption"
      | "leaseTtlSec"
      | "idleWakeBatch"
    >;
    now: Date;
    result: SwarmClaimSweepResult;
  },
): Promise<SwarmClaimSweepResult> {
  const { result } = input;
  const env = (deps as { env?: Record<string, string | undefined> }).env ?? process.env;
  // 1.6.5 (OPE-6608 D): the batch is a setting now. The variable still wins
  // when it is present and readable — an operator who set it on the host must
  // not be silently overridden by a stored value.
  const batch = hasSwarmIdleWakeBatchEnvOverride(env)
    ? readSwarmIdleWakeBatch(env)
    : input.settings.idleWakeBatch;
  const companyIds = await listActiveCompanies(deps.db);
  const liveCompanyClaims = await Promise.all(
    companyIds.map((companyId) => liveClaimCountsByAgent(deps.db, companyId)),
  );
  const claimCounts = new Map<string, number>();
  for (const counts of liveCompanyClaims) {
    for (const [agentId, count] of counts) claimCounts.set(agentId, count);
  }

  for (const companyId of companyIds) {
    const pairs = await listIdleRolePairs(deps.db, companyId);
    // myrmidon(1.6.1 SWARM-IDLE-WAKE): the pilot gate. A role outside the
    // pilot set (or a company outside the pilot company list) must not be
    // woken: its claim answers `disabled`, the run ends with nothing, and the
    // next tick would wake it again — an endless wake loop the ticket forbids
    // ("лид и ревьюеры в очередь разработки не входят").
    const pilotPairs = pairs.filter((pair) =>
      isSwarmClaimEnabledFor(input.settings, { companyId, role: pair.role }),
    );
    // myrmidon(1.6.1 CUSTOM-CASTES B): the same caste directory the claim gate
    // reads. `swarmEligible=false` castes never enter the idle pool; a
    // caste-set ceiling overrides the global one for that agent only.
    const casteByRole = deps.castes
      ? new Map((await deps.castes(companyId)).map((entry) => [entry.key, entry]))
      : new Map<string, CompanyCaste>();
    for (const pair of pilotPairs) {
      if (pair.agents.length === 0) {
        // The attention signal: ready work routed to a role no agent holds.
        result.idleUnstaffedRoles += 1;
        logger.warn(
          {
            role: pair.role,
            readyTasks: pair.queue.length,
            sample: pair.queue.slice(0, 5).map((task) => task.identifier ?? task.issueId),
          },
          "swarm idle pass: ready tasks are routed to a role with no agents; add an agent of the role or relabel the tasks",
        );
        continue;
      }
      const caste = casteByRole.get(pair.role);
      if (caste && !caste.swarmEligible) continue;
      const effectiveMaxActiveTasks =
        caste?.maxActiveTasks != null ? caste.maxActiveTasks : input.settings.maxActiveTasks;
      const roleInput: SwarmRoleIdleInput = {
        role: pair.role,
        queue: pair.queue,
        liveClaims: [], // claim coverage of the queue is checked per target below
        agents: pair.agents.map((agent) => ({
          id: agent.id,
          activeClaims: claimCounts.get(agent.id) ?? 0,
          maxActiveTasks: effectiveMaxActiveTasks,
          status: agent.status,
          hasLiveRun: agent.hasLiveRun,
          // 1.6.5 (OPE-6608 C): the agent's own switch, or — when it carries
          // none — the default rule: an eligible caste, and no reports under
          // the agent (a manager is not an executor). Agents that fail it are
          // not woken at all, so a lead never sees a queue task.
          queueEligible: resolveSwarmQueueEligibility({
            metadata: agent.metadata,
            casteEligible: caste?.swarmEligible ?? true,
            hasDirectReports: agent.hasDirectReports,
          }).eligible,
          // 1.6.5 (OPE-6608 B): the fair order needs to know who has been
          // idle longest, not just who is free.
          lastActiveAt: agent.lastActiveAt,
        })),
      };
      const targets = idleWakeTargetsForRole(roleInput, {
        batchLimit: batch,
        now: input.now,
        p0Preemption: input.settings.p0Preemption,
      });
      result.idleRoles += 1;
      result.idleFreeAgents += targets.length;
      for (const target of targets) {
        // A live claim or a queued/claimed wake already covers the task: the
        // admission path owns it; the next pass re-evaluates. This is the
        // fact-based idempotency (the key is tracing only, like idle-pickup).
        const covered = await issueHasLiveClaimOrWake(deps.db, companyId, target);
        if (covered) {
          result.idleFreeAgents -= 1;
          continue;
        }
        // 1.6.5 (OPE-6608 SWARM-WAKE-FIX A): the task is assigned and leased
        // HERE, on the server, before anyone is woken. The wake that follows
        // names an issue that already belongs to this agent, so the dispatcher
        // does not read the (NULL assignee ≠ run agent) pair as "reassigned"
        // and cancel the run — the failure that made all 3259 queue runs of
        // the 09.10 audit end as `skipped`. No other wake shape is produced:
        // the queue never sends an agent out to "go look for work".
        const claimed = await claimIdleTaskForAgent(deps, companyId, target, {
          now: input.now,
          leaseTtlSec: input.settings.leaseTtlSec,
        });
        if (!claimed) {
          result.idleFreeAgents -= 1;
          result.idleClaimLost += 1;
          continue;
        }
        result.idleClaimed += 1;
        try {
          const woke = await enqueueIdleWake(deps, companyId, target);
          if (woke) result.idleWoken += 1;
        } catch {
          // Best-effort per target: one failure does not fail the pass. The
          // assignment and the lease stay; the next pass finds the task owned
          // by this agent and retries the same wake.
          logger.warn(
            { agentId: target.agentId, issueId: target.issueId },
            "swarm idle wake target failed; the next pass retries",
          );
        }
      }
    }
  }
  return result;
}

/** True when a live claim or a pending wake already covers the task. */
export async function issueHasLiveClaimOrWake(
  db: Db,
  companyId: string,
  target: { issueId: string; agentId: string },
): Promise<boolean> {
  const claimRow = await db
    .select({ id: issueClaims.id })
    .from(issueClaims)
    .where(and(eq(issueClaims.issueId, target.issueId), isNull(issueClaims.releasedAt)))
    .limit(1);
  if (claimRow.length > 0) return true;
  const wakeRow = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${target.issueId}`,
        // myrmidon(HOLD-READY): a wake parked on an execution hold waits for a
        // person, it is not in flight; it must not keep the task covered.
        wakeNotParkedOnExecutionHold(),
      ),
    )
    .limit(1);
  if (wakeRow.length > 0) return true;
  // The task may already be in progress under another agent since the queue
  // read — re-read its status; anything outside the queue statuses is covered.
  const statusRow = await db
    .select({ status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, target.issueId), eq(issues.companyId, companyId)))
    .limit(1);
  const status = statusRow[0]?.status;
  if (status && !([...SWARM_CLAIM_QUEUE_ISSUE_STATUSES] as readonly string[]).includes(status)) {
    return true;
  }
  return false;
}

/**
 * 1.6.5 (OPE-6608 SWARM-WAKE-FIX A): take the task for the agent on the
 * server, before the wake. Two writes, in this order, and both must land:
 *
 *  1. the issue is assigned to the agent — a conditional update, so a task
 *     that left the queue (claimed by somebody else, moved out of `todo`,
 *     already assigned) is left alone;
 *  2. the lease row is written through `insertClaim`, the same write the
 *     checkout path uses, behind the same partial unique index.
 *
 * If the lease loses the race the assignment is reverted: the task must not
 * stay pinned to an agent that holds no claim. Only when both landed is the
 * agent woken — with the issue id in the payload, so the dispatcher sees a task
 * that already belongs to the agent it is waking (`decideIssueOwnership` no
 * longer reads it as "reassigned" and cancels the run before checkout).
 */
async function claimIdleTaskForAgent(
  deps: SwarmClaimServicePorts & { db: Db },
  companyId: string,
  target: { agentId: string; issueId: string; role: string; identifier: string | null; priority: string | null },
  input: { now: Date; leaseTtlSec: number },
): Promise<boolean> {
  const assigned = await assignIssueToAgentForIdleClaim(deps.db, {
    companyId,
    issueId: target.issueId,
    agentId: target.agentId,
    now: input.now,
  });
  if (!assigned) return false;

  const plan = planClaim({
    issueId: target.issueId,
    agentId: target.agentId,
    role: target.role,
    runId: null,
    now: input.now,
    settings: { leaseTtlSec: input.leaseTtlSec },
  });
  const claim = await insertClaim(deps.db, { companyId, ...plan });
  if (!claim) {
    await revertIdleClaimAssignment(deps.db, {
      companyId,
      issueId: target.issueId,
      agentId: target.agentId,
      now: input.now,
    });
    return false;
  }

  await deps.logActivity?.({
    companyId,
    actorType: "system",
    actorId: "swarm_idle_queue",
    agentId: target.agentId,
    runId: null,
    action: SWARM_CLAIM_CLAIMED_ACTION,
    entityType: "issue",
    entityId: target.issueId,
    details: {
      identifier: target.identifier,
      priority: target.priority,
      role: target.role,
      leaseTtlSec: input.leaseTtlSec,
      // The timeline says which path took the task: the queue, not a run's
      // own checkout.
      source: "swarm_idle_queue",
    },
  });
  return true;
}

async function enqueueIdleWake(
  deps: SwarmClaimServicePorts,
  companyId: string,
  target: { agentId: string; issueId: string; identifier: string | null; priority: string | null; role: string },
): Promise<boolean> {
  if (!deps.enqueueWakeup) return false;
  const wake = await deps.enqueueWakeup(target.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: SWARM_CLAIM_WAKE_REASON,
    idempotencyKey: idleWakeIdempotencyKey(target),
    requestedByActorType: "system",
    requestedByActorId: "swarm_idle_wake",
    contextSnapshot: {
      issueId: target.issueId,
      taskId: target.issueId,
      taskKey: target.issueId,
      source: "swarm_idle_wake",
      wakeReason: SWARM_CLAIM_WAKE_REASON,
      queueRole: target.role,
    },
  });
  return Boolean(wake);
}
