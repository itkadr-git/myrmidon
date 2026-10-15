// myrmidon(1.6-SWARM-CLAIM-B): API client for the "Swarm supervisor" page —
// per-caste task queues, active/expired role leases and rebalance actions.
// Server side (the JSON contract is frozen in the design note):
//   GET  .../swarm-claim/supervisor/overview
//   POST .../swarm-claim/supervisor/release-lease
// Until part A merges, the tests mock this client's return shape.

import { api } from "@/api/client";

export interface SwarmSupervisorQueueItem {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  projectId: string | null;
  createdAt: string;
  blockedTransitionAt: string | null;
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): the effective pheromone strength
   * — priority and waiting time folded into the number the queue orders by.
   */
  eff: number;
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): the nest the task sits in — the
   * assignee agent id, null when the task is unattributed.
   */
  nestAgentId: string | null;
}

export interface SwarmSupervisorTopQueueItem {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  role: string;
  projectId: string | null;
  createdAt: string;
  /** myrmidon(1.6.5 SWARM-T4, design §5.3): effective pheromone strength. */
  eff: number;
  /** The agent whose nest (queue position) the row reflects, if any. */
  nestAgentId: string | null;
}

export interface SwarmSupervisorClaim {
  claimId: string;
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  agentId: string;
  agentName: string;
  claimedAt: string;
  expiresAt: string;
  heartbeatAt: string | null;
  expired: boolean;
  secondsToExpiry: number;
}

export interface SwarmSupervisorIdleAgent {
  agentId: string;
  name: string;
  activeClaims: number;
  atLimit: boolean;
}

export interface SwarmSupervisorRole {
  role: string;
  queue: SwarmSupervisorQueueItem[];
  claims: SwarmSupervisorClaim[];
  idleAgents: SwarmSupervisorIdleAgent[];
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): one recent board→agent match, read
 * from the `issue.swarm_matched` activity feed. Empty until the matching
 * core lands.
 */
export interface SwarmSupervisorMatch {
  at: string;
  issueId: string;
  identifier: string | null;
  title: string;
  agentId: string;
  agentName: string;
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): one task the board failed to match
 * and left to cool down. From T5; empty until it lands.
 */
export interface SwarmSupervisorCooldown {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  createdAt: string;
  coolsDownAt: string | null;
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): one warning of the overview —
 * a caste with tasks and no free agent, tasks without a caste, runs without
 * a task in the last 24 hours.
 */
export type SwarmWarningKind =
  | "caste_without_agents"
  | "tasks_without_caste"
  | "runs_without_task";

export interface SwarmSupervisorWarning {
  kind: SwarmWarningKind;
  message: string;
  caste?: string;
  issueCount?: number;
  runCount?: number;
}

export interface SwarmSupervisorTotals {
  queued: number;
  activeClaims: number;
  expiredClaims: number;
  agentsWithClaims: number;
  idleAgentsWithQueue: number;
  freeAgentsWithQueue: number;
}

export interface SwarmSupervisorOverview {
  enabled: boolean;
  generatedAt: string;
  leaseTtlSec: number | null;
  maxActiveTasksPerAgent: number | null;
  /**
   * myrmidon(1.6.1 SWARM-SETTINGS-UI): where each effective claim setting
   * came from — "settings" (the UI), "env" (the forced override) or "default".
   */
  settingSources: Record<string, string>;
  totals: SwarmSupervisorTotals;
  roles: SwarmSupervisorRole[];
  topQueue: SwarmSupervisorTopQueueItem[];
  matched: SwarmSupervisorMatch[];
  cooldown: SwarmSupervisorCooldown[];
  warnings: SwarmSupervisorWarning[];
}

export interface SwarmReleaseLeaseInput {
  claimId: string;
  reason?: string;
}

export interface SwarmReleaseLeaseResult {
  released: boolean;
  claimId: string;
  issueId: string | null;
  wokenAgentId: string | null;
  reason: string;
}

const supervisorBase = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/swarm-claim/supervisor`;

export const swarmSupervisorApi = {
  overview: (companyId: string) =>
    api.get<SwarmSupervisorOverview>(`${supervisorBase(companyId)}/overview`),

  releaseLease: (companyId: string, input: SwarmReleaseLeaseInput) =>
    api.post<SwarmReleaseLeaseResult>(`${supervisorBase(companyId)}/release-lease`, {
      claimId: input.claimId,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
};

export const swarmSupervisorOverviewKey = (companyId: string) =>
  ["myrmidon", "swarm-claim", "supervisor", "overview", companyId] as const;
