// server/src/myrmidon/swarm-claim/hooks.ts
//
// myrmidon(1.6-SWARM): the two run-lifecycle hooks the vendor heartbeat file
// calls. Keeping them here (not inline in heartbeat.ts) keeps the vendor
// diff one-line-per-call and testable without the 30k-line service.
//
// - recordSwarmClaimOnCheckout: the checkout is the claim event; the run now
//   holds the issue's lease.
// - releaseSwarmClaimsForRun: the finishing run frees the lease. The wake of
//   the agent that just became free is the matcher's (review item 2), not a
//   "next agent of the caste" guess made here.

import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_RELEASED_ACTION,
  SWARM_CLAIM_RELEASE_REASON_RUN_FINISHED,
  readStoredSwarmSettings,
  resolveSwarmClaimSettings,
} from "@paperclipai/shared";
import { planClaim } from "./domain.js";
import { findLiveClaimForIssue, heartbeatClaim, insertClaim, releaseClaim } from "./store.js";
import { logActivity as logActivityService } from "../../services/activity-log.js";

/** Shared ports shape both hooks need. */
interface HookDeps {
  db: Db;
  settings: { getGeneral(): Promise<unknown> };
}

function resolved(deps: HookDeps) {
  return async () =>
    resolveSwarmClaimSettings({
      stored: readStoredSwarmSettings(
        (await deps.settings.getGeneral()) as unknown as Record<string, unknown> | undefined,
      ),
      env: process.env,
    });
}

/**
 * myrmidon(1.6-SWARM): a checkout creates (or refreshes) the run's claim on
 * the issue. Idempotent: an existing live claim for the same agent is
 * heartbeated, one for another agent is left alone (the checkout guard has
 * already decided who owns the issue).
 */
export async function recordSwarmClaimOnCheckoutImpl(
  deps: HookDeps,
  input: {
    run: { id: string; companyId: string; agentId: string };
    agent: { id: string; role: string };
    issueId: string;
  },
  now = new Date(),
): Promise<boolean> {
  const { settings } = await resolved(deps)();
  if (!settings.enabled) return false;
  // 1.6.5 (OPE-6608, review item 5): there is no pilot set. One switch for the
  // whole instance; a caste keeps its agents out of the queue through the
  // directory, not through a company list nobody maintains.

  const existing = await findLiveClaimForIssue(deps.db, input.issueId);
  if (existing) {
    if (existing.agentId !== input.agent.id) return false;
    // Same agent re-checking out (a continuation wake): push the lease one
    // TTL forward rather than stacking a second row.
    const { heartbeatClaim } = await import("./store.js");
    return heartbeatClaim(deps.db, { claimId: existing.id, heartbeatAt: now, expiresAt: new Date(now.getTime() + settings.leaseTtlSec * 1000) });
  }

  const plan = planClaim({
    issueId: input.issueId,
    agentId: input.agent.id,
    role: input.agent.role,
    runId: input.run.id,
    now,
    settings,
  });
  const claim = await insertClaim(deps.db, { companyId: input.run.companyId, ...plan });
  if (claim) {
    await logActivityService(deps.db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "swarm_claim",
      agentId: input.agent.id,
      runId: input.run.id,
      action: "issue.swarm_claim.claimed",
      entityType: "issue",
      entityId: input.issueId,
      details: { source: "checkout", leaseTtlSec: settings.leaseTtlSec },
    }).catch(() => undefined);
  }
  return Boolean(claim);
}

/**
 * myrmidon(1.6-SWARM): a finishing run releases the claim it holds (and only
 * the claim it holds — a claim owned by another agent's run is not touched),
 * then wakes the next agent of the issue's role.
 */
export async function releaseSwarmClaimsForRunImpl(
  deps: HookDeps & {
    db: Db;
  },
  run: { id: string; companyId: string },
  now = new Date(),
): Promise<string[]> {
  const { settings } = await resolved(deps)();
  if (!settings.enabled) return [];

  // The claims of this run's agent on this company's issues — restricted to
  // the issue the run actually held, which the heartbeat run row knows.
  const runRow = await deps.db
    .select({ nativeIssueId: heartbeatRuns.nativeIssueId, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)))
    .limit(1);
  const held = runRow[0];
  if (!held?.nativeIssueId) return [];

  const live = await findLiveClaimForIssue(deps.db, held.nativeIssueId);
  if (!live || live.agentId !== held.agentId) return [];

  const released = await releaseClaim(deps.db, {
    claimId: live.id,
    reason: SWARM_CLAIM_RELEASE_REASON_RUN_FINISHED,
    now,
  });
  if (!released) return [];

  await logActivityService(deps.db, {
    companyId: run.companyId,
    actorType: "system",
    actorId: "swarm_claim",
    agentId: held.agentId,
    runId: run.id,
    action: SWARM_CLAIM_RELEASED_ACTION,
    entityType: "issue",
    entityId: held.nativeIssueId,
    details: { reason: SWARM_CLAIM_RELEASE_REASON_RUN_FINISHED },
  }).catch(() => undefined);

  // No wake from here (review item 2): the hook frees the lease, nothing else.
  // The release path of the run lifecycle (heartbeat.ts) hands the agent that
  // just became free to the matcher, which gives it a task of its own.
  return [live.id];
}