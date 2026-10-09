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
import { companies, agentWakeupRequests, heartbeatRuns, issues, issueClaims, type Db } from "@paperclipai/db";
import { wakeNotParkedOnExecutionHold } from "../settled-holds/ready-predicate.js";
import {
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_RELEASE_REASON_ISSUE_CLOSED,
  SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED,
  SWARM_CLAIM_RELEASED_ACTION,
  isSwarmLeaseExpired,
  resolveSwarmClaimSettings,
  type SwarmClaimSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { currentHostCpuGate, currentHostMemoryGate, type HostCpuGate, type HostMemoryGate } from "../run-admission.js";
import { matchCompany, matchIssue, type SwarmMatcherDeps } from "./matcher.js";
import type { SwarmClaimServicePorts } from "./service.js";
import {
  clearExpiredAssignee,
  listClaimsOnNonQueueIssues,
  listExpiredClaims,
  releaseClaim,
} from "./store.js";

/** The sweep inspects at most this many claims per pass. */
export const SWARM_CLAIM_SWEEP_PAGE_SIZE = 50;

// myrmidon(1.6.5 OPE-6608, review item 5): the idle-wake batch is gone with the
// pass it capped. Nothing here reads MYRMIDON_SWARM_IDLE_WAKE_BATCH any more:
// the matcher hands every ready task to a free agent of its caste in one
// transaction, so "how many agents may one pass wake" has no meaning left. The
// shared schema entry and its env reader still live in
// `packages/shared/src/myrmidon-swarm-claim.ts`, the file T2 (OPE-6614) edits
// and merges before this branch: it leaves with that merge (design «Удалить»,
// item 3), not from under T2's feet.
//
// The activity of a task whose lease lapsed with no run behind it (design §4.1,
// item 6 of the same list): the board took the task back off its owner.
const SWARM_CLAIM_UNASSIGNED_ON_EXPIRY_ACTION = "issue.swarm_claim.unassigned_on_expiry";

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
          // design §4.1 (review item 2): the lease ran out and no run holds the
          // task any more, so the task goes back to the queue WITHOUT its
          // owner. The old pass left the assignee in place and woke the next
          // agent of the caste on a task that still belonged to somebody else —
          // that wake was cancelled as `reassigned` before its checkout, the
          // very failure this ticket exists for. Clearing the owner first and
          // then matching wakes exactly the agent that now owns the task.
          const rematched = await reclaimExpiredTask(
            deps,
            settings,
            { companyId: row.companyId, issueId: row.issueId, agentId: row.agentId },
            now,
          ).catch(() => false);
          if (rematched) result.woken += 1;
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

      // myrmidon(1.6.5 OPE-6608 A, review item 1): the third pass is the
      // board-side matcher now (design §3.5), not the per-role idle wake it
      // replaced — no batch, no "who has waited longest". The pass runs after
      // the release passes, so a lease released in this very tick is already
      // back in the queue the pools read.
      // myrmidon(1.6.2 RUN-ADMISSION): no pairing while the host floor is
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
        const matched = await runMatcherPass(deps, settings, now);
        result.idleClaimed += matched.claimed;
        result.idleWoken += matched.claimed;
        result.idleRoles += matched.companies;
        // Ready tasks no free agent of their caste was found for — the number
        // an operator watches while the fleet is saturated.
        result.idleFreeAgents += matched.unmatched;
        if (matched.claimed > 0) {
          logger.warn(
            {
              claimed: matched.claimed,
              unmatched: matched.unmatched,
              companies: matched.companies,
            },
            "swarm matcher paired ready tasks with free agents of their caste",
          );
        }
      } catch {
        // CONSTANT errorKind only (the exception can carry a credential).
        logger.warn(
          { errorKind: "swarm_match_failed" },
          "swarm matcher pass failed; the next tick retries",
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
 * 1.6.5 (OPE-6608 §4.1, review item 2): one expired lease, re-matched. A task
 * whose lease lapsed with no live run behind it is nobody's again — the owner
 * is cleared (only while the task is still in a queue status and still carries
 * that owner, so a task that moved on is left alone), the activity records it,
 * and the matcher pairs the task again on this same pass. A live run keeps its
 * task: an idle lease expiring must never take work away from a running agent.
 */
async function reclaimExpiredTask(
  deps: SwarmClaimSweeperDeps,
  settings: SwarmClaimSettings,
  target: { companyId: string; issueId: string; agentId: string },
  now: Date,
): Promise<boolean> {
  if (await hasLiveRunForAgent(deps.db, target.companyId, target.agentId)) return false;

  const cleared = await clearExpiredAssignee(deps.db, {
    companyId: target.companyId,
    issueId: target.issueId,
    agentId: target.agentId,
    now,
  });
  if (cleared) {
    await deps.logActivity?.({
      companyId: target.companyId,
      actorType: "system",
      actorId: "swarm_claim_sweep",
      agentId: target.agentId,
      runId: null,
      action: SWARM_CLAIM_UNASSIGNED_ON_EXPIRY_ACTION,
      entityType: "issue",
      entityId: target.issueId,
      details: { reason: SWARM_CLAIM_RELEASE_REASON_LEASE_EXPIRED },
    });
  }
  if (!deps.enqueueWakeup) return false;
  const matched = await matchIssue(matcherDeps(deps, settings, now), target.issueId);
  return Boolean(matched);
}

/** True while a queued/running/scheduled_retry run of the agent covers its task. */
async function hasLiveRunForAgent(db: Db, companyId: string, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * One matcher pass over every active company (design §3.5 — the safety net of
 * the event path): the periodic tick only re-reads what an event may have
 * missed. The pairing is the same code a single task or a single agent event
 * runs, so "top of the queue" and "free agent" mean one thing everywhere.
 */
async function runMatcherPass(
  deps: SwarmClaimSweeperDeps,
  settings: SwarmClaimSettings,
  now: Date,
): Promise<{ claimed: number; unmatched: number; companies: number }> {
  const companyIds = await listActiveCompanies(deps.db);
  if (!deps.enqueueWakeup) return { claimed: 0, unmatched: 0, companies: companyIds.length };
  const matcher = matcherDeps(deps, settings, now);
  let claimed = 0;
  let unmatched = 0;
  for (const companyId of companyIds) {
    const matched = await matchCompany(matcher, companyId);
    claimed += matched.pairs.length;
    unmatched += matched.unmatched;
  }
  return { claimed, unmatched, companies: companyIds.length };
}

/**
 * The matcher ports of the sweeper. The host gate is reported open on purpose:
 * this pass only runs after both gates were read above, and every event path
 * checks its own admission — the floor's job is to hold back a whole sweep, not
 * a single pair. The caste directory is passed straight through (T3's port).
 */
function matcherDeps(
  deps: SwarmClaimSweeperDeps,
  settings: SwarmClaimSettings,
  now: Date,
): SwarmMatcherDeps {
  return {
    db: deps.db,
    heartbeat: {
      wakeup: async (agentId, opts) => {
        const wakeup = deps.enqueueWakeup;
        if (!wakeup) return null;
        // The claim service's wake port is declared with the narrower field
        // set the queue wakes used (source "automation", no payload); the
        // heartbeat path behind it takes the wider shape the matcher sends
        // (source "assignment", the issue in the payload). The call is
        // forwarded unchanged — this module only relays it.
        return wakeup(agentId, opts as unknown as Parameters<typeof wakeup>[1]);
      },
    },
    settings,
    hostGateOpen: true,
    now,
    casteDirectory: deps.castes,
    logActivity: deps.logActivity,
  };
}
