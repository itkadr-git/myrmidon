// server/src/myrmidon/monitoring/metrics/capacity-producer.ts
//
// myrmidon(1.6.6 OPE-9565): the authoritative production producer of the five
// capacity dashboard metrics specified in OPE-9564:
//   - myrmidon_readiness_ratio
//   - myrmidon_queue_age_seconds
//   - myrmidon_project_share{project}
//   - myrmidon_starvation_total
//   - myrmidon_claim_rejection_total{reason}
//
// Contract v1 (company-scoped snapshot; never mix companies):
// 1. readiness_ratio (gauge): ready / open.
//    open = all non-done, non-cancelled issues of the target company (including blocked & in_review).
//    ready = subset that an authoritative eligibility resolver can issue to an eligible agent
//            right now without violating guards and without active claim/run.
//    open == 0 -> 0. Unknown eligibility -> unavailable (null), never fake 0.
// 2. queue_age_seconds (gauge): max(0, snapshotTime - readySince) across ready issues.
//    readySince = start of continuous eligibility period.
//    Empty known ready queue -> 0. Missing readySince -> unavailable (null).
// 3. project_share{project} (gauge): active claim/run slots for project / total active slots.
//    Slot counted once per claim/run identity (deduped).
//    project = stable project UUID; unassigned issues -> "unassigned".
//    Emit only snapshot projects (with open issues or active slots).
//    totalActive == 0 -> 0 for each project. totalActive > 0 -> sum of shares == 1.
// 4. starvation_total (counter): ready episodes continuously unclaimed >= policy.starvation.afterMin.
//    One increment per (issueId, episodeId) when crossing threshold. Re-scrape does not increment.
//    Claim or loss of eligibility ends the episode. When policy.enabled == false, no new events.
// 5. claim_rejection_total{reason} (counter): authoritative final rejection events.
//    Closed vocabulary: capacity_limit, project_scope, caste_scope, assignment_conflict,
//    dependency_blocked, interaction_pending, already_claimed, not_ready, other.
//    Deduplicated by attemptId on replay.

import type { Db } from "@myrmidon/db";
import {
  agents,
  companies,
  heartbeatRuns,
  instanceSettings,
  issueClaims,
  issues,
} from "@myrmidon/db";
import { and, eq, gt, inArray, isNull, notInArray } from "drizzle-orm";
import {
  DEFAULT_CAPACITY_POLICY,
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  type CapacityPolicy,
} from "@myrmidon/shared";
import {
  CLAIM_REJECTION_REASONS,
  type CapacityDashboardMetricsProvider,
  type CapacityDashboardMetricsSnapshot,
  type ClaimRejectionReason,
} from "./metrics.js";

interface ReadyEpisode {
  episodeId: string;
  readySince: Date;
  starvationIncremented: boolean;
}

// Process-local lifetime state for ready episodes and counters.
const readyEpisodesByCompany = new Map<string, Map<string, ReadyEpisode>>();

// Bounded LRU/history of attempt IDs to dedupe replayed claim attempts.
const recentRejectionAttempts = new Set<string>();
const MAX_ATTEMPT_HISTORY = 5000;

function createEmptyRejectionCounters(): Record<ClaimRejectionReason, number> {
  const result = {} as Record<ClaimRejectionReason, number>;
  for (const reason of CLAIM_REJECTION_REASONS) {
    result[reason] = 0;
  }
  return result;
}

let starvationTotalCounter = 0;
let claimRejectionCounters: Record<ClaimRejectionReason, number> = createEmptyRejectionCounters();

/**
 * Record an authoritative final claim rejection event.
 * If attemptId is provided, subsequent calls with the same attemptId are deduped.
 */
export function recordCapacityClaimRejection(
  reason: ClaimRejectionReason | string,
  attemptId?: string | null,
): void {
  if (attemptId) {
    if (recentRejectionAttempts.has(attemptId)) return;
    recentRejectionAttempts.add(attemptId);
    if (recentRejectionAttempts.size > MAX_ATTEMPT_HISTORY) {
      const first = recentRejectionAttempts.values().next().value;
      if (first !== undefined) recentRejectionAttempts.delete(first);
    }
  }

  const normalizedReason: ClaimRejectionReason = (CLAIM_REJECTION_REASONS as readonly string[]).includes(reason)
    ? (reason as ClaimRejectionReason)
    : "other";

  claimRejectionCounters[normalizedReason] = (claimRejectionCounters[normalizedReason] ?? 0) + 1;
}

/**
 * Reset all process-local capacity metrics state (for testing or instance re-initialization).
 */
export function resetCapacityMetrics(): void {
  starvationTotalCounter = 0;
  claimRejectionCounters = createEmptyRejectionCounters();
  readyEpisodesByCompany.clear();
  recentRejectionAttempts.clear();
}

/**
 * Inspect process-local counters directly.
 */
export function readCapacityCounters(): {
  starvationTotal: number;
  claimRejectionTotal: Record<ClaimRejectionReason, number>;
} {
  return {
    starvationTotal: starvationTotalCounter,
    claimRejectionTotal: { ...claimRejectionCounters },
  };
}

export interface ProduceCapacityMetricsDeps {
  db: Db;
  now?: () => Date;
  companyId?: string;
  policy?: CapacityPolicy;
}

/**
 * Authoritative production producer for CapacityDashboardMetricsSnapshot.
 * Returns null if the source is unavailable, DB is inaccessible, or no valid company exists.
 */
export async function produceCapacityMetrics(
  deps: ProduceCapacityMetricsDeps,
): Promise<CapacityDashboardMetricsSnapshot | null> {
  if (!deps.db || typeof deps.db.select !== "function") {
    return null;
  }

  const now = deps.now ? deps.now() : new Date();

  // Resolve target company ID
  let targetCompanyId = deps.companyId;
  if (!targetCompanyId) {
    const companyRows = await deps.db.select({ id: companies.id }).from(companies).limit(1);
    if (companyRows.length === 0 || !companyRows[0]?.id) {
      return null;
    }
    targetCompanyId = companyRows[0].id;
  }

  // Resolve capacity policy
  let policy = deps.policy;
  if (!policy) {
    try {
      const [settings] = await deps.db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, "default"))
        .limit(1);
      const general = (settings?.general ?? {}) as Record<string, unknown>;
      policy = (general.capacityPolicy as CapacityPolicy) ?? DEFAULT_CAPACITY_POLICY;
    } catch {
      policy = DEFAULT_CAPACITY_POLICY;
    }
  }

  // 1. Query open issues (all non-done, non-cancelled issues of this company)
  const openRows = await deps.db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      unresolvedBlockerCount: issues.unresolvedBlockerCount,
      unresolvedInteractionCount: issues.unresolvedInteractionCount,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, targetCompanyId),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    );

  // 2. Query active claims and active heartbeat runs
  const [activeClaims, activeRuns, activeAgents] = await Promise.all([
    deps.db
      .select({
        id: issueClaims.id,
        issueId: issueClaims.issueId,
        agentId: issueClaims.agentId,
      })
      .from(issueClaims)
      .where(
        and(
          eq(issueClaims.companyId, targetCompanyId),
          isNull(issueClaims.releasedAt),
          gt(issueClaims.expiresAt, now),
        ),
      ),
    deps.db
      .select({
        id: heartbeatRuns.id,
        issueId: heartbeatRuns.issueId,
        agentId: heartbeatRuns.agentId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, targetCompanyId),
          inArray(heartbeatRuns.status, ["running", "queued"]),
        ),
      ),
    deps.db
      .select({
        id: agents.id,
        role: agents.role,
        status: agents.status,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, targetCompanyId),
          notInArray(agents.status, ["paused", "terminated"]),
        ),
      ),
  ]);

  const activeClaimIssueIds = new Set(activeClaims.map((c) => c.issueId));
  const activeRunIssueIds = new Set(
    activeRuns.map((r) => r.issueId).filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  // Map of issueId -> projectId from openRows and all active slots
  const issueProjectMap = new Map<string, string | null>();
  for (const row of openRows) {
    issueProjectMap.set(row.id, row.projectId ?? null);
  }

  // Active slots: count each active slot once per issue (dedupe claim + run on same issue)
  const activeSlotIssueIds = new Set<string>();
  for (const c of activeClaims) activeSlotIssueIds.add(c.issueId);
  for (const r of activeRuns) {
    if (r.issueId) activeSlotIssueIds.add(r.issueId);
  }

  // If there are active slots on issues not in openRows, fetch their project IDs
  const missingIssueIds = Array.from(activeSlotIssueIds).filter((id) => !issueProjectMap.has(id));
  if (missingIssueIds.length > 0) {
    const extraRows = await deps.db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(inArray(issues.id, missingIssueIds));
    for (const r of extraRows) {
      issueProjectMap.set(r.id, r.projectId ?? null);
    }
  }

  // Compute active slots per project
  const projectActiveSlots = new Map<string, number>();
  for (const issueId of activeSlotIssueIds) {
    const proj = issueProjectMap.get(issueId) ?? "unassigned";
    projectActiveSlots.set(proj, (projectActiveSlots.get(proj) ?? 0) + 1);
  }

  const totalActiveSlots = activeSlotIssueIds.size;

  // Snapshot projects: distinct projects from open issues OR active slots
  const snapshotProjectSet = new Set<string>();
  for (const row of openRows) {
    snapshotProjectSet.add(row.projectId ?? "unassigned");
  }
  for (const proj of projectActiveSlots.keys()) {
    snapshotProjectSet.add(proj);
  }

  const sortedProjects = Array.from(snapshotProjectSet).sort((a, b) => a.localeCompare(b));
  const projectShare: Array<{ project: string; share: number }> = sortedProjects.map((project) => {
    if (totalActiveSlots === 0) {
      return { project, share: 0 };
    }
    const count = projectActiveSlots.get(project) ?? 0;
    return { project, share: count / totalActiveSlots };
  });

  // 3. Determine ready issues
  const readyStatuses = new Set<string>(SWARM_CLAIM_QUEUE_ISSUE_STATUSES);
  const eligibleAgentRoles = new Set(activeAgents.map((a) => a.role));
  const activeAgentIds = new Set(activeAgents.map((a) => a.id));

  const readyIssues = openRows.filter((issue) => {
    // Must be in ready status (e.g. 'todo')
    if (!readyStatuses.has(issue.status)) return false;
    // Must not have an active lease claim
    if (activeClaimIssueIds.has(issue.id)) return false;
    // Must not have an active run
    if (activeRunIssueIds.has(issue.id)) return false;
    // Must not have unresolved blockers
    if ((issue.unresolvedBlockerCount ?? 0) > 0) return false;
    // Must not have unresolved interactions
    if ((issue.unresolvedInteractionCount ?? 0) > 0) return false;
    // If assigned to a specific agent, that agent must be active
    if (issue.assigneeAgentId && !activeAgentIds.has(issue.assigneeAgentId)) {
      return false;
    }
    // Company must have at least one active agent
    if (activeAgents.length === 0) return false;

    return true;
  });

  // 4. Calculate readinessRatio
  const readinessRatio = openRows.length === 0 ? 0 : readyIssues.length / openRows.length;

  // 5. Episode tracking & starvationTotal
  let companyEpisodes = readyEpisodesByCompany.get(targetCompanyId);
  if (!companyEpisodes) {
    companyEpisodes = new Map<string, ReadyEpisode>();
    readyEpisodesByCompany.set(targetCompanyId, companyEpisodes);
  }

  const currentReadyIds = new Set(readyIssues.map((i) => i.id));

  // Purge episodes for issues that exited the ready queue (claim, blocked, completed, etc.)
  for (const issueId of companyEpisodes.keys()) {
    if (!currentReadyIds.has(issueId)) {
      companyEpisodes.delete(issueId);
    }
  }

  // Update or insert episodes for ready issues
  for (const issue of readyIssues) {
    let episode = companyEpisodes.get(issue.id);
    if (!episode) {
      episode = {
        episodeId: `${issue.id}-${now.getTime()}`,
        readySince: issue.updatedAt ?? issue.createdAt ?? now,
        starvationIncremented: false,
      };
      companyEpisodes.set(issue.id, episode);
    }

    // Check starvation threshold if policy enabled
    if (policy.enabled && policy.starvation) {
      const elapsedMin = (now.getTime() - episode.readySince.getTime()) / (60 * 1000);
      if (elapsedMin >= policy.starvation.afterMin && !episode.starvationIncremented) {
        starvationTotalCounter += 1;
        episode.starvationIncremented = true;
      }
    }
  }

  // 6. Calculate queueAgeSeconds
  let queueAgeSeconds: number | null = null;
  if (readyIssues.length === 0) {
    queueAgeSeconds = 0;
  } else {
    let maxAge = 0;
    let missingReadySince = false;
    for (const issue of readyIssues) {
      const ep = companyEpisodes.get(issue.id);
      if (!ep || !ep.readySince || !(ep.readySince instanceof Date) || isNaN(ep.readySince.getTime())) {
        missingReadySince = true;
        break;
      }
      const ageSec = Math.max(0, Math.floor((now.getTime() - ep.readySince.getTime()) / 1000));
      if (ageSec > maxAge) maxAge = ageSec;
    }
    queueAgeSeconds = missingReadySince ? null : maxAge;
  }

  return {
    readinessRatio,
    queueAgeSeconds,
    projectShare,
    starvationTotal: starvationTotalCounter,
    claimRejectionTotal: { ...claimRejectionCounters },
  };
}

/**
 * Creates the default injectable provider wired to production DB and clock.
 */
export function createDefaultCapacityDashboardProvider(
  db: Db,
  now?: () => Date,
): CapacityDashboardMetricsProvider {
  return () => produceCapacityMetrics({ db, now });
}
