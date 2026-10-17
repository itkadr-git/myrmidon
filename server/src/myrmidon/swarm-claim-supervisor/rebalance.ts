// myrmidon(1.6-SWARM-CLAIM-B): the supervisor's rebalance action.
//
// One action: release a live lease, take the owner off the task and hand it to
// the board matcher, which pairs it with a free agent of its caste. The claim table and the
// release path belong to part A (`server/src/myrmidon/swarm-claim/`): when
// part A's `releaseClaim` is importable it is used (it also writes the
// `issue.swarm_claim.released` activity); otherwise the port falls back to a
// direct `UPDATE issue_claims SET released_at` and this module writes its own
// audit record. Part B never re-assigns an issue by hand — the queue decides.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { SwarmSupervisorReadPort } from "./view.js";
import { createSwarmSupervisorDbPort } from "./view.js";
import { clearExpiredAssignee } from "../swarm-claim/store.js";

export const SUPERVISOR_RELEASE_REASON = "supervisor_rebalance";
export const SWARM_CLAIM_SUPERVISOR_RELEASE_ACTION = "issue.swarm_claim_supervisor_release";

export interface SwarmReleaseLeaseResult {
  released: boolean;
  claimId: string;
  issueId: string | null;
  /** The agent the matcher paired with the task (and woke); null when none was free. */
  wokenAgentId: string | null;
  reason: string;
}

export class ClaimNotFoundError extends Error {
  constructor(claimId: string) {
    super(`claim ${claimId} not found`);
    this.name = "ClaimNotFoundError";
  }
}

export class ClaimNotLiveError extends Error {
  readonly code = "claim_not_live";
  constructor(claimId: string) {
    super(`claim ${claimId} is not live`);
    this.name = "ClaimNotLiveError";
  }
}

export interface SwarmRebalanceDeps {
  port: SwarmSupervisorReleasePort;
  /**
   * The event "the task has no owner and is ready" (design §3.5): the board's
   * matcher for one task (`matcher.forIssue`). It owns the wake — admission
   * limits and gates are enforced inside it. Absent (the swarm is off or in a
   * unit test), the release stands alone.
   */
  matchIssue?: (issueId: string) => Promise<{ agentId: string } | null>;
  /** Optional activity log; absent in unit tests. */
  logActivity?: (input: {
    companyId: string;
    actorType: "agent" | "user" | "system";
    actorId: string;
    agentId: string | null;
    runId: null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now(): Date;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Release a live lease, take the owner off the task and hand it to the matcher. Throws
 * `ClaimNotFoundError` / `ClaimNotLiveError` for the 404/409 cases; returns
 * `released: false` only when part A's release path declined the release.
 */
export async function releaseLeaseForRebalance(
  deps: SwarmRebalanceDeps,
  companyId: string,
  claimId: string,
  reasonInput?: string,
  actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
): Promise<SwarmReleaseLeaseResult> {
  const reason = reasonInput?.trim() ? reasonInput.trim() : SUPERVISOR_RELEASE_REASON;
  const nowMs = deps.now().getTime();

  const claimRows = await deps.port.listClaimRows(companyId);
  const claim = claimRows.find((row) => row.claim_id === claimId);
  if (!claim) throw new ClaimNotFoundError(claimId);
  if (toDate(claim.released_at) !== null) throw new ClaimNotLiveError(claimId);
  const expiresAt = toDate(claim.expires_at);
  if (expiresAt && expiresAt.getTime() < nowMs) throw new ClaimNotLiveError(claimId);

  const released = await releaseThroughPort(deps, companyId, claimId, reason, deps.now());
  if (!released) {
    // Part A's release path declined (for example the claim was released
    // concurrently); report it without a match.
    return { released: false, claimId, issueId: claim.issue_id, wokenAgentId: null, reason };
  }

  // 1.6.5 (OPE-6608, review item 3 / design §4.2): the lease is gone, so the
  // task stops being the holder's — the board takes the owner off it and hands
  // it to the matcher, which pairs it with a free agent of its caste (ties by
  // the smallest agent id) and wakes THAT agent for a task that is already its
  // own. The old shape (leave the owner, wake "the next agent of the role" by
  // load) woke an agent for a task owned by somebody else; the dispatcher
  // cancelled that run as `reassigned` before its checkout, and the same
  // holder kept the task, so nothing rotated. The wake is best-effort: the
  // periodic matcher pass is the safety net.
  let wokenAgentId: string | null = null;
  try {
    await deps.port.unassignIssue(companyId, claim.issue_id, claim.agent_id, deps.now());
  } catch {
    // The release already happened; an owner left in place is picked up again
    // by the periodic pass, which never wakes anyone for a foreign task.
  }
  if (deps.matchIssue) {
    try {
      const pair = await deps.matchIssue(claim.issue_id);
      wokenAgentId = pair?.agentId ?? null;
    } catch {
      wokenAgentId = null;
    }
  }

  if (deps.logActivity) {
    try {
      await deps.logActivity({
        companyId,
        actorType: actor?.actorType === "agent" ? "agent" : actor?.actorType === "system" ? "system" : "user",
        actorId: actor?.actorId ?? "board",
        agentId: claim.agent_id,
        runId: null,
        action: SWARM_CLAIM_SUPERVISOR_RELEASE_ACTION,
        entityType: "issue",
        entityId: claim.issue_id,
        details: {
          claimId,
          reason,
          wokenAgentId,
          via: "supervisor_rebalance",
        },
      });
    } catch {
      // Audit is best-effort; the release already happened.
    }
  }

  return { released: true, claimId, issueId: claim.issue_id, wokenAgentId, reason };
}

/**
 * Prefer part A's `releaseClaim` (it owns the semantics and its activity
 * record); fall back to the direct UPDATE on the shared claim table.
 */
async function releaseThroughPort(
  deps: SwarmRebalanceDeps,
  companyId: string,
  claimId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const release = await resolvePartARelease();
  if (release) {
    try {
      const db = (deps.port as { db?: Db }).db;
      if (db) return await release(db, { claimId, reason, now });
    } catch {
      // fall through to the direct path
    }
  }
  return deps.port.releaseClaim(companyId, claimId, reason, now);
}

interface PartAReleaseClaim {
  (db: Db, input: { claimId: string; reason: string; now?: Date; releasedStatus?: string }): Promise<boolean>;
}

/** Part A's store module path; a non-literal specifier so this compiles first. */
const PART_A_STORE_MODULE = "../swarm-claim/store.js";

async function resolvePartARelease(): Promise<PartAReleaseClaim | null> {
  try {
    const specifier = PART_A_STORE_MODULE;
    const mod = (await import(specifier)) as Record<string, unknown>;
    const candidate = mod["releaseClaim"];
    return typeof candidate === "function" ? (candidate as PartAReleaseClaim) : null;
  } catch {
    return null;
  }
}

/**
 * Extend the shared read port with the release write. The db implementation
 * prefers part A's function (see releaseThroughPort) and otherwise performs
 * the additive UPDATE itself.
 */
export interface SwarmSupervisorReleasePort extends SwarmSupervisorReadPort {
  releaseClaim(companyId: string, claimId: string, reason: string, now: Date): Promise<boolean>;
  /** Take the owner off a queue-status task (conditional on the owner still being `agentId`). */
  unassignIssue(companyId: string, issueId: string, agentId: string, now: Date): Promise<boolean>;
}

export function createSwarmSupervisorReleasePort(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): SwarmSupervisorReleasePort {
  const base = createSwarmSupervisorDbPort(db, env);
  return {
    ...base,
    async releaseClaim(companyId, claimId, reason, now) {
      const releasedAt = new Date(now).toISOString();
      // The fallback keeps part A's release-history invariant: the reason is
      // written next to releasedAt, so the supervisor view can tell a
      // supervisor release from an expired lease. Once part A's store is
      // importable (after its merge) this whole fallback goes away and the
      // dynamic `releaseClaim` import becomes the only release path.
      const releasedReason = reason || SUPERVISOR_RELEASE_REASON;
      const rows = await db.execute(sql`
        UPDATE issue_claims
        SET released_at = ${releasedAt}, release_reason = ${releasedReason}
        WHERE company_id = ${companyId}
          AND id = ${claimId}
          AND released_at IS NULL
        RETURNING id
      `);
      return Array.isArray(rows) && rows.length > 0;
    },
    unassignIssue: (companyId, issueId, agentId, now) =>
      clearExpiredAssignee(db, { companyId, issueId, agentId, now }),
  };
}