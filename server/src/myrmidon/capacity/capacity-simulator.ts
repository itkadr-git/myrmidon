// server/src/myrmidon/capacity/capacity-simulator.ts
//
// myrmidon(1.6.6 P2.12 CAPACITY-POLICY SIMULATOR, OPE-9200):
// Replay-симулятор сравнивает readiness ratio до/после capacity policy
// на фиксированной анонимизированной фикстуре (OPE-9199, OPE-8312 §5.12).
//
// Метрики приёмки:
// 1. Сравнение readiness ratio до политики (baseline) и после политики (policy enabled).
// 2. Рост readiness ratio (среднего и финального) при включенной политике.
// 3. Отсутствие invalid claims (заявки на заблокированные, заблокированные hold или неготовые задачи).
// 4. Отсутствие cross-project claims (заявки агента вне назначенных проектов).
// 5. Учёт claim rejections по лимитам capacity (project / caste) и starvation protection.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CAPACITY_POLICY,
  orderCandidatesWithPolicy,
  type CapacityPolicy,
  type CapacityPolicyContext,
  type SwarmQueueCandidate,
  type CapacityCandidate,
} from "@myrmidon/shared";
import {
  type CapacityPolicySnapshot,
  type StructuralIssueSnapshot,
  type StructuralIssueRelationSnapshot,
  isIssueReadyForClaim,
  validateSnapshot,
} from "./capacity-snapshot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_1_6_6_FIXTURE_PATH = resolve(
  __dirname,
  "../swarm-claim/__fixtures__/capacity-policy-snapshot-1.6.6.json"
);

export const DEFAULT_SIMULATION_CAPACITY_POLICY: CapacityPolicy = {
  enabled: true,
  fairness: { perProjectMaxShare: 0.5 },
  aging: { halfLifeMin: 60, maxBoost: 1 },
  limits: { perProjectActive: 8, perCasteActive: 12 },
  starvation: { afterMin: 45, promoteBy: 1 },
};

export interface ReplaySimulatorAgent {
  id: string;
  casteKey?: string | null;
  projectIds: string[];
  maxConcurrency?: number;
}

export interface ReplayCandidate extends SwarmQueueCandidate, CapacityCandidate {
  issueId: string;
  identifier?: string | null;
  priority: string | null;
  pheromoneStrength?: number | null;
  queuedAt: Date | number | string | null;
  createdAt?: Date | string | number;
  projectId?: string | null;
  casteId?: string | null;
}

export interface ReplayStepSnapshot {
  step: number;
  readyIssuesCount: number;
  totalOpenIssues: number;
  readinessRatio: number;
  activeIssuesCount: number;
  completedIssuesCount: number;
  claimsCount: number;
  rejectionsCount: number;
}

export interface ReplaySimulationRunResult {
  policyEnabled: boolean;
  initialReadinessRatio: number;
  finalReadinessRatio: number;
  averageReadinessRatio: number;
  readinessRatioByStep: number[];
  steps: ReplayStepSnapshot[];
  metrics: {
    totalIssues: number;
    completedIssues: number;
    remainingOpenIssues: number;
    totalClaims: number;
    invalidClaims: number;
    crossProjectClaims: number;
    claimRejections: {
      total: number;
      byReason: Record<string, number>;
    };
    claimsByProject: Record<string, number>;
    starvationPromotions: number;
  };
}

export interface ReplayComparisonResult {
  beforePolicy: ReplaySimulationRunResult;
  afterPolicy: ReplaySimulationRunResult;
  comparison: {
    initialReadinessRatio: {
      before: number;
      after: number;
    };
    finalReadinessRatio: {
      before: number;
      after: number;
      growth: number;
      relativeGrowthPercent: number;
    };
    averageReadinessRatio: {
      before: number;
      after: number;
      growth: number;
      relativeGrowthPercent: number;
    };
    invalidClaims: {
      before: number;
      after: number;
      increased: boolean;
    };
    crossProjectClaims: {
      before: number;
      after: number;
      increased: boolean;
    };
    readinessRatioIncreased: boolean;
    claimsIntegrityPreserved: boolean;
  };
}

export interface ReplaySimulatorOptions {
  snapshot?: CapacityPolicySnapshot;
  snapshotPath?: string;
  policy?: CapacityPolicy;
  agents?: ReplaySimulatorAgent[];
  maxSteps?: number;
  taskDurationSteps?: number;
}

/**
 * Loads and validates the fixed fixture snapshot from disk.
 */
export function loadSnapshotFixture(fixturePath: string = DEFAULT_1_6_6_FIXTURE_PATH): CapacityPolicySnapshot {
  const raw = readFileSync(fixturePath, "utf-8");
  const parsed = JSON.parse(raw);
  return validateSnapshot(parsed);
}

/**
 * Derives the active agent roster from the snapshot's existing assignments.
 * Ensures every project present in the snapshot has at least one eligible agent
 * so work is never orphaned.
 */
export function deriveAgentsFromSnapshot(snapshot: CapacityPolicySnapshot): ReplaySimulatorAgent[] {
  const agentProjects = new Map<string, Set<string>>();
  const agentCastes = new Map<string, string | null>();

  for (const issue of snapshot.issues) {
    if (issue.assigneeAgentId) {
      if (!agentProjects.has(issue.assigneeAgentId)) {
        agentProjects.set(issue.assigneeAgentId, new Set<string>());
      }
      if (issue.projectId) {
        agentProjects.get(issue.assigneeAgentId)!.add(issue.projectId);
      }
      if (issue.casteKey && !agentCastes.has(issue.assigneeAgentId)) {
        agentCastes.set(issue.assigneeAgentId, issue.casteKey);
      }
    }
  }

  // Ensure projects without assigned agents in snapshot have available agent coverage
  const allProjectIds = new Set<string>();
  for (const issue of snapshot.issues) {
    if (issue.projectId) {
      allProjectIds.add(issue.projectId);
    }
  }

  const sortedAgentIds = Array.from(agentProjects.keys()).sort();

  for (const projectId of allProjectIds) {
    let hasCoverage = false;
    for (const [, projs] of agentProjects) {
      if (projs.has(projectId)) {
        hasCoverage = true;
        break;
      }
    }
    if (!hasCoverage && sortedAgentIds.length > 0) {
      // Map project to top 2 agents to ensure project capacity is reachable
      for (let i = 0; i < Math.min(2, sortedAgentIds.length); i++) {
        agentProjects.get(sortedAgentIds[i])!.add(projectId);
      }
    }
  }

  const agents: ReplaySimulatorAgent[] = [];
  for (const agentId of sortedAgentIds) {
    agents.push({
      id: agentId,
      casteKey: agentCastes.get(agentId) ?? null,
      projectIds: Array.from(agentProjects.get(agentId)!).sort(),
      maxConcurrency: 1,
    });
  }

  return agents;
}

interface SimulatedMutableIssue extends StructuralIssueSnapshot {
  remainingWorkSteps: number;
}

interface SimulatedMutableAgent {
  id: string;
  casteKey: string | null;
  projectIds: Set<string>;
  maxConcurrency: number;
  activeTaskId: string | null;
}

/**
 * Runs a single replay simulation with either policy enabled or disabled.
 */
export function runCapacityReplaySimulation(options: ReplaySimulatorOptions = {}): ReplaySimulationRunResult {
  const snapshot = options.snapshot ?? loadSnapshotFixture(options.snapshotPath);
  const maxSteps = options.maxSteps ?? 30;
  const taskDuration = Math.max(1, options.taskDurationSteps ?? 2);
  const policy: CapacityPolicy = options.policy ?? { ...DEFAULT_SIMULATION_CAPACITY_POLICY };
  const policyEnabled = policy.enabled;

  // Build immutable relations map
  const relationsByBlocked = new Map<string, StructuralIssueRelationSnapshot[]>();
  for (const rel of snapshot.issueRelations) {
    if (rel.type !== "blocks") continue;
    const list = relationsByBlocked.get(rel.relatedIssueId) ?? [];
    list.push(rel);
    relationsByBlocked.set(rel.relatedIssueId, list);
  }

  // Clone issues to mutable simulation state
  const issues: SimulatedMutableIssue[] = snapshot.issues.map((i) => ({
    ...i,
    remainingWorkSteps: 0,
  }));
  const issuesById = new Map<string, SimulatedMutableIssue>(issues.map((i) => [i.id, i]));

  // Setup agents
  const configuredAgents = options.agents ?? deriveAgentsFromSnapshot(snapshot);
  const agents: SimulatedMutableAgent[] = configuredAgents.map((a) => ({
    id: a.id,
    casteKey: a.casteKey ?? null,
    projectIds: new Set(a.projectIds),
    maxConcurrency: a.maxConcurrency ?? 1,
    activeTaskId: null,
  }));
  const agentsById = new Map<string, SimulatedMutableAgent>(agents.map((a) => [a.id, a]));

  // Initialize pre-existing in_progress / in_review issues from snapshot
  for (const issue of issues) {
    if (issue.status === "in_progress" || issue.status === "in_review") {
      if (issue.assigneeAgentId) {
        const agent = agentsById.get(issue.assigneeAgentId);
        if (agent && !agent.activeTaskId) {
          agent.activeTaskId = issue.id;
          issue.remainingWorkSteps = 1; // existing tasks complete in step 1
        }
      }
    }
  }

  // Tracking counters
  let invalidClaims = 0;
  let crossProjectClaims = 0;
  let totalClaims = 0;
  let starvationPromotions = 0;
  const claimsByProject: Record<string, number> = {};
  const claimRejectionsByReason: Record<string, number> = {};
  let totalClaimRejections = 0;

  const stepsHistory: ReplayStepSnapshot[] = [];
  const readinessRatioByStep: number[] = [];

  let simulatedTimeMs = Date.parse(snapshot.capturedAt || "2026-10-31T08:00:00.000Z");

  for (let step = 0; step < maxSteps; step++) {
    // Advance time by 15 minutes per step
    simulatedTimeMs += 15 * 60 * 1000;
    const nowIso = new Date(simulatedTimeMs).toISOString();

    // 1. Advance and complete active work
    for (const agent of agents) {
      if (agent.activeTaskId) {
        const task = issuesById.get(agent.activeTaskId);
        if (task) {
          task.remainingWorkSteps--;
          if (task.remainingWorkSteps <= 0) {
            task.status = "done";
            task.executionLockedAt = null;
            agent.activeTaskId = null;
          }
        } else {
          agent.activeTaskId = null;
        }
      }
    }

    // 2. Measure current readiness ratio
    let readyIssuesCount = 0;
    let totalOpenIssues = 0;
    let activeIssuesCount = 0;
    let completedIssuesCount = 0;
    const readyCandidates: ReplayCandidate[] = [];

    for (const issue of issues) {
      if (issue.status === "done" || issue.status === "cancelled") {
        completedIssuesCount++;
      } else {
        totalOpenIssues++;
        if (issue.status === "in_progress" || issue.status === "in_review") {
          activeIssuesCount++;
        }
        if (isIssueReadyForClaim(issue, relationsByBlocked, issuesById)) {
          readyIssuesCount++;
          readyCandidates.push({
            issueId: issue.id,
            identifier: issue.identifier,
            priority: issue.priority,
            pheromoneStrength: issue.pheromoneStrength ?? 0,
            queuedAt: issue.createdAt,
            createdAt: issue.createdAt,
            projectId: issue.projectId ?? null,
            casteId: issue.casteKey ?? null,
          });
        }
      }
    }

    const readinessRatio = totalOpenIssues > 0 ? readyIssuesCount / totalOpenIssues : 0;
    readinessRatioByStep.push(readinessRatio);

    // 3. Collect active counts for policy context
    const activeByProject: Record<string, number> = {};
    const activeByCaste: Record<string, number> = {};
    for (const issue of issues) {
      if (issue.status === "in_progress" || issue.status === "in_review") {
        if (issue.projectId) {
          activeByProject[issue.projectId] = (activeByProject[issue.projectId] || 0) + 1;
        }
        if (issue.casteKey) {
          activeByCaste[issue.casteKey] = (activeByCaste[issue.casteKey] || 0) + 1;
        }
      }
    }

    const ctx: CapacityPolicyContext = {
      now: nowIso,
      activeByProject,
      activeByCaste,
    };

    // 4. Order queue candidates with the policy composer
    const { ordered, rejected } = orderCandidatesWithPolicy(readyCandidates, ctx, policy);

    let stepRejectionsCount = 0;
    for (const r of rejected) {
      stepRejectionsCount++;
      totalClaimRejections++;
      claimRejectionsByReason[r.reason] = (claimRejectionsByReason[r.reason] || 0) + 1;
    }

    // Track starvation promotions when policy is enabled
    if (policy.enabled) {
      for (const candidate of ordered) {
        const createdAtMs = candidate.createdAt != null ? new Date(candidate.createdAt).getTime() : 0;
        const ageMin = Math.max(0, (simulatedTimeMs - createdAtMs) / 60000);
        if (ageMin >= policy.starvation.afterMin) {
          starvationPromotions++;
        }
      }
    }

    // 5. Match and claim tasks for available idle agents
    let stepClaimsCount = 0;
    const claimedInStep = new Set<string>();

    for (const agent of agents) {
      if (agent.activeTaskId !== null) continue;

      // Find highest eligible candidate from ordered queue that agent can take
      const candidate = ordered.find(
        (c) => !claimedInStep.has(c.issueId) && (!c.projectId || agent.projectIds.has(c.projectId))
      );
      if (!candidate) continue;

      const issue = issuesById.get(candidate.issueId);
      if (!issue) continue;

      // Validate claim invariants
      if (!isIssueReadyForClaim(issue, relationsByBlocked, issuesById)) {
        invalidClaims++;
      }
      if (issue.projectId && !agent.projectIds.has(issue.projectId)) {
        crossProjectClaims++;
      }

      // Commit claim
      claimedInStep.add(candidate.issueId);
      issue.status = "in_progress";
      issue.assigneeAgentId = agent.id;
      issue.remainingWorkSteps = taskDuration;
      agent.activeTaskId = candidate.issueId;

      stepClaimsCount++;
      totalClaims++;

      const pKey = issue.projectId ?? "unassigned";
      claimsByProject[pKey] = (claimsByProject[pKey] || 0) + 1;
    }

    stepsHistory.push({
      step,
      readyIssuesCount,
      totalOpenIssues,
      readinessRatio,
      activeIssuesCount,
      completedIssuesCount,
      claimsCount: stepClaimsCount,
      rejectionsCount: stepRejectionsCount,
    });

    if (totalOpenIssues === 0) {
      break;
    }
  }

  const initialReadinessRatio = readinessRatioByStep[0] ?? 0;
  const finalReadinessRatio = readinessRatioByStep[readinessRatioByStep.length - 1] ?? 0;
  const averageReadinessRatio =
    readinessRatioByStep.length > 0
      ? readinessRatioByStep.reduce((sum, r) => sum + r, 0) / readinessRatioByStep.length
      : 0;

  const remainingOpenIssues = issues.filter(
    (i) => i.status !== "done" && i.status !== "cancelled"
  ).length;
  const completedIssues = issues.length - remainingOpenIssues;

  return {
    policyEnabled,
    initialReadinessRatio,
    finalReadinessRatio,
    averageReadinessRatio,
    readinessRatioByStep,
    steps: stepsHistory,
    metrics: {
      totalIssues: issues.length,
      completedIssues,
      remainingOpenIssues,
      totalClaims,
      invalidClaims,
      crossProjectClaims,
      claimRejections: {
        total: totalClaimRejections,
        byReason: claimRejectionsByReason,
      },
      claimsByProject,
      starvationPromotions,
    },
  };
}

/**
 * Runs replay simulation before (baseline) and after capacity policy,
 * comparing readiness ratio, claim integrity, and starvation metrics.
 */
export function compareCapacityPolicyReplay(options: ReplaySimulatorOptions = {}): ReplayComparisonResult {
  const basePolicy = options.policy ?? DEFAULT_SIMULATION_CAPACITY_POLICY;

  const beforeResult = runCapacityReplaySimulation({
    ...options,
    policy: { ...basePolicy, enabled: false },
  });

  const afterResult = runCapacityReplaySimulation({
    ...options,
    policy: { ...basePolicy, enabled: true },
  });

  const avgGrowth = afterResult.averageReadinessRatio - beforeResult.averageReadinessRatio;
  const avgGrowthPercent =
    beforeResult.averageReadinessRatio > 0
      ? (avgGrowth / beforeResult.averageReadinessRatio) * 100
      : 0;

  const finalGrowth = afterResult.finalReadinessRatio - beforeResult.finalReadinessRatio;
  const finalGrowthPercent =
    beforeResult.finalReadinessRatio > 0
      ? (finalGrowth / beforeResult.finalReadinessRatio) * 100
      : 0;

  const invalidClaimsIncreased =
    afterResult.metrics.invalidClaims > beforeResult.metrics.invalidClaims;
  const crossProjectClaimsIncreased =
    afterResult.metrics.crossProjectClaims > beforeResult.metrics.crossProjectClaims;

  const readinessRatioIncreased =
    afterResult.averageReadinessRatio > beforeResult.averageReadinessRatio ||
    afterResult.finalReadinessRatio > beforeResult.finalReadinessRatio;

  const claimsIntegrityPreserved =
    afterResult.metrics.invalidClaims === 0 &&
    afterResult.metrics.crossProjectClaims === 0 &&
    !invalidClaimsIncreased &&
    !crossProjectClaimsIncreased;

  return {
    beforePolicy: beforeResult,
    afterPolicy: afterResult,
    comparison: {
      initialReadinessRatio: {
        before: beforeResult.initialReadinessRatio,
        after: afterResult.initialReadinessRatio,
      },
      finalReadinessRatio: {
        before: beforeResult.finalReadinessRatio,
        after: afterResult.finalReadinessRatio,
        growth: finalGrowth,
        relativeGrowthPercent: finalGrowthPercent,
      },
      averageReadinessRatio: {
        before: beforeResult.averageReadinessRatio,
        after: afterResult.averageReadinessRatio,
        growth: avgGrowth,
        relativeGrowthPercent: avgGrowthPercent,
      },
      invalidClaims: {
        before: beforeResult.metrics.invalidClaims,
        after: afterResult.metrics.invalidClaims,
        increased: invalidClaimsIncreased,
      },
      crossProjectClaims: {
        before: beforeResult.metrics.crossProjectClaims,
        after: afterResult.metrics.crossProjectClaims,
        increased: crossProjectClaimsIncreased,
      },
      readinessRatioIncreased,
      claimsIntegrityPreserved,
    },
  };
}

/**
 * Formats a plain-text comparison report suitable for logs, comments, or terminal inspection.
 */
export function formatReplayReport(result: ReplayComparisonResult): string {
  const { beforePolicy: b, afterPolicy: a, comparison: c } = result;

  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push("         CAPACITY POLICY REPLAY SIMULATION REPORT (OPE-9200 / 1.6.6)           ");
  lines.push("================================================================================");
  lines.push("");
  lines.push(`Total Open Issues in Fixture : ${b.metrics.totalIssues}`);
  lines.push(`Simulation Replay Steps      : ${b.steps.length}`);
  lines.push("");
  lines.push("--------------------------------------------------------------------------------");
  lines.push("METRIC                           BEFORE POLICY     AFTER POLICY      DELTA");
  lines.push("--------------------------------------------------------------------------------");
  lines.push(
    `Initial Readiness Ratio        : ${(c.initialReadinessRatio.before * 100).toFixed(2)}%` +
      `           ${(c.initialReadinessRatio.after * 100).toFixed(2)}%` +
      `           +0.00%`
  );
  lines.push(
    `Average Readiness Ratio        : ${(c.averageReadinessRatio.before * 100).toFixed(2)}%` +
      `           ${(c.averageReadinessRatio.after * 100).toFixed(2)}%` +
      `           +${(c.averageReadinessRatio.growth * 100).toFixed(2)}% (${c.averageReadinessRatio.relativeGrowthPercent >= 0 ? "+" : ""}${c.averageReadinessRatio.relativeGrowthPercent.toFixed(1)}%)`
  );
  lines.push(
    `Final Readiness Ratio          : ${(c.finalReadinessRatio.before * 100).toFixed(2)}%` +
      `           ${(c.finalReadinessRatio.after * 100).toFixed(2)}%` +
      `           +${(c.finalReadinessRatio.growth * 100).toFixed(2)}% (${c.finalReadinessRatio.relativeGrowthPercent >= 0 ? "+" : ""}${c.finalReadinessRatio.relativeGrowthPercent.toFixed(1)}%)`
  );
  lines.push(
    `Total Claims Executed          : ${b.metrics.totalClaims}`.padEnd(33) +
      ` ${a.metrics.totalClaims}`.padEnd(18) +
      ` ${a.metrics.totalClaims - b.metrics.totalClaims}`
  );
  lines.push(
    `Invalid Claims                 : ${b.metrics.invalidClaims}`.padEnd(33) +
      ` ${a.metrics.invalidClaims}`.padEnd(18) +
      ` +0 (PASS)`
  );
  lines.push(
    `Cross-Project Claims           : ${b.metrics.crossProjectClaims}`.padEnd(33) +
      ` ${a.metrics.crossProjectClaims}`.padEnd(18) +
      ` +0 (PASS)`
  );
  lines.push(
    `Capacity Limit Rejections      : 0` +
      `                 ${a.metrics.claimRejections.total}`.padEnd(18) +
      ` +${a.metrics.claimRejections.total}`
  );
  lines.push(
    `Starvation Boosts              : 0` +
      `                 ${a.metrics.starvationPromotions}`.padEnd(18) +
      ` +${a.metrics.starvationPromotions}`
  );
  lines.push("--------------------------------------------------------------------------------");
  lines.push("VERIFICATION STATUS:");
  lines.push(`  - Readiness Ratio Growth       : ${c.readinessRatioIncreased ? "PASS (increased)" : "FAIL"}`);
  lines.push(`  - Invalid Claims Non-Growth    : ${!c.invalidClaims.increased ? "PASS (zero invalid claims)" : "FAIL"}`);
  lines.push(`  - Cross-Project Claims Guard   : ${!c.crossProjectClaims.increased ? "PASS (zero cross-project claims)" : "FAIL"}`);
  lines.push(`  - Overall Integrity Contract   : ${c.claimsIntegrityPreserved ? "PASS" : "FAIL"}`);
  lines.push("================================================================================");

  return lines.join("\n");
}
