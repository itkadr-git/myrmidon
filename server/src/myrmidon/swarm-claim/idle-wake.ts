// server/src/myrmidon/swarm-claim/idle-wake.ts
//
// myrmidon(1.6.1 SWARM-IDLE-WAKE): the pure decision core of the idle pass.
//
// The fact of 03.10: three engineers sat idle while two ready unassigned tasks
// waited in the engineer queue. The lease sweep only wakes on a release; it
// never looks at "queue non-empty AND free agents exist". This module decides
// exactly that pair, without a database and without a clock of its own, so the
// verdict matrix (limit, P0, batch cap, paused, castes) is testable in unit
// tests and the sweep only executes what the policy decided.

import {
  orderIdleWakeAgents,
  orderSwarmQueueCandidates,
  swarmActiveTaskLimitReached,
  type SwarmClaimLease,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";

/** One candidate wake target the sweep judged free. */
export interface SwarmIdleWakeTarget {
  agentId: string;
  /** The top queue task this agent's claim would take — the wake binds to it. */
  issueId: string;
  identifier: string | null;
  priority: string | null;
  role: string;
}

/**
 * A queue entry of the idle pass. `assigneeAgentId` is set for a task already
 * assigned to an agent (it belongs to that agent alone) and empty for an
 * unassigned task (any free agent of the role may take it).
 */
export interface SwarmIdleQueueCandidate extends SwarmQueueCandidate {
  assigneeAgentId?: string | null;
}

/** The idle read of one role, as the queue reads assemble it. */
export interface SwarmRoleIdleInput {
  role: string;
  /** The role's ready queue candidates, un-ordered (order applied here). */
  queue: readonly SwarmIdleQueueCandidate[];
  /** Live (not released, un-expired) claims of the whole company. */
  liveClaims: readonly SwarmClaimLease[];
  /** The role's agents as the read reports them. */
  agents: readonly {
    id: string;
    activeClaims: number;
    /** Effective ceiling for this agent: caste override or the global one. */
    maxActiveTasks: number | null;
    status: string | null;
    /** True when a live heartbeat run (queued/running/scheduled_retry) covers the agent. */
    hasLiveRun: boolean;
    /**
     * 1.6.5 (OPE-6608 C): the agent's own queue switch (caste default applied).
     * Absent means "yes" so a caller that does not know the agent is not
     * silently excluded.
     */
    queueEligible?: boolean;
    /**
     * 1.6.5 (OPE-6608 B): when the agent last worked, for the fair order.
     * Absent/null means it never ran — the idlest agent of the role.
     */
    lastActiveAt?: Date | null;
  }[];
}

export interface SwarmIdleWakeOptions {
  /** Upper bound of agents woken by one pass — the ≤5 batch cap. */
  batchLimit: number;
  /** Time the pass runs at; lease liveness is judged against it. */
  now: Date;
  /**
   * myrmidon(1.6.1 SWARM-SETTINGS-UI): the P0 preemption setting. The idle
   * pass binds agents to the top task in the SAME order the claim path takes
   * it; with preemption off the queue is strictly oldest-first.
   */
  p0Preemption: boolean;
}

/** The number of wakes the pair "queue + free agents" needs right now. */
export function neededIdleWakes(input: SwarmRoleIdleInput): number {
  return freeAgentsOfRole(input).length;
}

/**
 * The role's agents that may take one more task right now, in the fair order
 * of 1.6.5 (OPE-6608 B): least loaded first, longest idle first among equals,
 * so no agent stays the head of the list pass after pass.
 */
export function freeAgentsOfRole(input: SwarmRoleIdleInput): SwarmRoleIdleInput["agents"][number][] {
  return orderIdleWakeAgents(
    input.agents.filter(
      (agent) =>
        agent.queueEligible !== false &&
        agent.status !== "paused" &&
        agent.status !== "error" &&
        !agent.hasLiveRun &&
        !swarmActiveTaskLimitReached(agent.activeClaims, { maxActiveTasks: agent.maxActiveTasks }),
    ),
  );
}

/**
 * Decide one role's wake targets: the free agents, in the role's own agent
 * order, each bound to the top task the queue still offers — critical first,
 * oldest entry second (the same order a claim would take). One agent per
 * queue task: the second free agent gets the second task, not the first one's
 * double. The pass is capped by the batch limit.
 */
export function idleWakeTargetsForRole(
  input: SwarmRoleIdleInput,
  options: SwarmIdleWakeOptions,
): SwarmIdleWakeTarget[] {
  const claimed = new Set(
    input.liveClaims
      .filter((claim) => claim.releasedAt === null || claim.releasedAt === undefined)
      .map((claim) => claim.issueId),
  );
  const ordered = orderSwarmQueueCandidates(input.queue, {
    p0Preemption: options.p0Preemption,
  }).filter((candidate) => !claimed.has(candidate.issueId));
  const free = freeAgentsOfRole(input);
  const targets: SwarmIdleWakeTarget[] = [];
  // myrmidon(1.6.2 SWARM-UNASSIGNED-ROUTE): each free agent takes its OWN
  // top task first (assigned to it), else the top UNASSIGNED task of the role.
  // A task assigned to a peer is never offered to this agent: pairing agent i
  // with queue slot i let peers' assigned tasks fill every slot and starved the
  // unassigned tasks behind them (04.10: 16 idle engineers, 24 ready
  // unassigned tasks, no wake).
  const taken = new Set<string>();
  for (const agent of free) {
    const own = ordered.find(
      (candidate) => !taken.has(candidate.issueId) && candidate.assigneeAgentId === agent.id,
    );
    const top =
      own ??
      ordered.find((candidate) => !taken.has(candidate.issueId) && !candidate.assigneeAgentId);
    if (!top) continue;
    taken.add(top.issueId);
    targets.push({
      agentId: agent.id,
      issueId: top.issueId,
      identifier: top.identifier ?? null,
      priority: top.priority ?? null,
      role: input.role,
    });
  }
  return targets.slice(0, Math.max(0, options.batchLimit));
}

/**
 * The wake idempotency key of one idle target. Fact-based, like idle-pickup:
 * the key is tracing only — the sweep checks a covering wake/claim before it
 * wakes, so a second pass on the same pair is a no-op by construction.
 */
export function idleWakeIdempotencyKey(target: Pick<SwarmIdleWakeTarget, "issueId">): string {
  return `swarm_idle_wake:${target.issueId}`;
}
