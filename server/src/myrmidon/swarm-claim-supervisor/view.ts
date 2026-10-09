// myrmidon(1.6-SWARM-CLAIM-B): the supervisor read port over the swarm claim
// machinery.
//
// Part B is strictly a reader here: it aggregates per-role queues, live and
// expired claims and per-agent load. The claim table itself (`issue_claims`)
// and every write to it belong to part A (`server/src/myrmidon/swarm-claim/`);
// when part A's module is not present this port reports `enabled: false` and
// the surface answers 503 instead of guessing.
//
// The queue shape mirrors `listRoleQueue`/`orderSwarmQueueCandidates` from part
// A (priority critical first, then high, medium, low; older blockedTransitionAt
// first) so the supervisor sees exactly the order agents claim from. The
// ordering is re-implemented locally (pure ranking of the rows the port
// fetched) because importing part A's domain module would make this file fail
// to compile before part A lands; the ranking itself is a frozen contract.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { readSwarmSupervisorSettings } from "./settings.js";
// myrmidon(1.6.1 SWARM-SETTINGS-UI): the same resolver the core uses, so the
// supervisor's "where the value came from" and the settings page agree.
import { resolveSwarmClaimSettings } from "@paperclipai/shared";

/** Wake reason part A assigns to queue-driven wakes; informational in the view. */
export const SWARM_CLAIM_QUEUE_WAKE_REASON = "swarm_claim_queue";

/**
 * myrmidon(1.6.5 SWARM-T4): the activity action T2/T3 write when the board
 * itself matches a queued task to a free agent. Until T3 merges the log is
 * empty and the overview simply reports no recent matches; the literal is the
 * frozen contract from design §5.3.
 */
export const SWARM_MATCHED_ACTION = "issue.swarm_matched";

export interface SwarmQueueCandidateRow {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  projectId: string | null;
  createdAt: string;
  blockedTransitionAt: string | null;
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): the effective pheromone strength
   * of the task — priority and aging combined into the single number the
   * queue orders by. Absent on rows produced before the swarm scent lands
   * (0 there); the ordering never depends on it being present.
   */
  eff: number;
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): the nest (queue position holder)
   * the task currently sits in — the assignee agent id when the task is
   * attributed to a caste queue, null when it is unattributed.
   */
  nestAgentId: string | null;
}

export interface SwarmClaimLeaseRow {
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

export interface SwarmIdleAgentRow {
  agentId: string;
  name: string;
  activeClaims: number;
  atLimit: boolean;
}

export interface SwarmRoleOverview {
  role: string;
  queue: SwarmQueueCandidateRow[];
  claims: SwarmClaimLeaseRow[];
  idleAgents: SwarmIdleAgentRow[];
}

/** myrmidon(1.6.5 SWARM-T4, design §5.3): one recent board→agent match. */
export interface SwarmMatchedRow {
  at: string;
  issueId: string;
  identifier: string | null;
  title: string;
  agentId: string;
  agentName: string;
}

/** myrmidon(1.6.5 SWARM-T4, design §5.3): one task the board failed to match and left to cool down. */
export interface SwarmCooldownRow {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  createdAt: string;
  /** When the cooldown ends and the task re-enters the queue; from T5, absent until it lands. */
  coolsDownAt: string | null;
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): one warning the owner should see on
 * the overview. `kind` selects the sentence, the counts/ids carry the detail.
 */
export interface SwarmWarningRow {
  kind: "caste_without_agents" | "tasks_without_caste" | "runs_without_task";
  message: string;
  /** The caste key when the kind is caste-scoped. */
  caste?: string;
  issueCount?: number;
  runCount?: number;
}

export interface SwarmSupervisorOverview {
  enabled: boolean;
  generatedAt: string;
  leaseTtlSec: number | null;
  maxActiveTasksPerAgent: number | null;
  /**
   * 1.6.1 (SWARM-SETTINGS-UI): where each effective setting came from —
   * "settings" (the UI), "env" (the forced override) or "default". Rendered
   * by the supervisor screen next to the values, so the operator sees at a
   * glance whether the row or the environment is in charge.
   */
  settingSources: Record<string, string>;
  totals: {
    queued: number;
    activeClaims: number;
    expiredClaims: number;
    agentsWithClaims: number;
    idleAgentsWithQueue: number;
    /**
     * myrmidon(1.6.1 SWARM-IDLE-WAKE): free agents (no live run, not
     * paused/error, under the ceiling) at a non-empty queue. The zero metric
     * of the ticket: this is what the idle pass drives to 0.
     */
    freeAgentsWithQueue: number;
  };
  roles: SwarmRoleOverview[];
  topQueue: {
    issueId: string;
    identifier: string | null;
    title: string;
    priority: string;
    role: string;
    projectId: string | null;
    createdAt: string;
  }[];
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): the recent board→agent matches,
   * newest first, read from the activity log (`issue.swarm_matched`). Until
   * the matching core (T3) lands this is empty — the surface is live, the
   * feed is not yet written.
   */
  matched: SwarmMatchedRow[];
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): tasks the board failed to match
   * and left to cool down. From T5; until it lands this is empty.
   */
  cooldown: SwarmCooldownRow[];
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): warnings — a caste with queued
   * tasks but no free agents, tasks without a caste, runs without a task in
   * the last 24 hours.
   */
  warnings: SwarmWarningRow[];
}

/**
 * Minimal shape of one `issue_claims` row as this module reads it. Defined
 * locally (not imported from part A) so the module compiles before part A
 * merges; the column names are part A's frozen contract.
 */
interface ClaimRow {
  claim_id: string;
  issue_id: string;
  agent_id: string;
  claimed_at: Date | string;
  expires_at: Date | string;
  heartbeat_at: Date | string | null;
  released_at: Date | string | null;
}

interface QueueRow {
  issue_id: string;
  identifier: string | null;
  title: string;
  priority: string;
  project_id: string | null;
  created_at: Date | string;
  blocked_transition_at: Date | string | null;
  /** Read when present: the role filter of the queue is the assignee's role. */
  assignee_agent_id?: string | null;
}

interface AgentRow {
  agent_id: string;
  agent_name: string;
  role: string;
  status: string;
}

/** The DB read port, overridable in unit tests with an in-memory fake. */
export interface SwarmSupervisorReadPort {
  /** Whether part A's claim machinery is present and switched on. */
  claimEnabled(): Promise<boolean>;
  /** Part A's effective lease TTL in seconds, when known. */
  leaseTtlSec(): Promise<number | null>;
  /** Part A's effective per-agent limit of active tasks, when known. */
  maxActiveTasksPerAgent(): Promise<number | null>;
  /**
   * 1.6.1 (SWARM-SETTINGS-UI): where each effective claim setting came from
   * ("settings" | "env" | "default"), keyed by setting key.
   */
  settingSources(): Promise<Record<string, string>>;
  /** Claim rows of the company (live + released history rows included). */
  listClaimRows(companyId: string): Promise<ClaimRow[]>;
  /** Queued candidates per issue id (todo, ready, not claimed right now). */
  listQueueRows(companyId: string): Promise<QueueRow[]>;
  /** Agents of the company that could ever hold a claim. */
  listAgents(companyId: string): Promise<AgentRow[]>;
  /** Live run statuses per agent id, for the idle heuristic. */
  liveRunAgentIds(companyId: string): Promise<Set<string>>;
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): the recent `issue.swarm_matched`
   * activity rows, newest first. The board→agent match feed; empty until the
   * matching core (T3) writes the action.
   */
  listMatchedRows(companyId: string): Promise<MatchedActivityRow[]>;
  /**
   * myrmidon(1.6.5 SWARM-T4, design §5.3): finished run rows of the last 24
   * hours with their task id (null = the run had no task), for the
   * "runs without a task" warning.
   */
  listRecentRunTaskIds(companyId: string): Promise<RecentRunRow[]>;
}

/** One `issue.swarm_matched` activity row as the port reads it. */
interface MatchedActivityRow {
  at: Date | string;
  issue_id: string;
  agent_id: string;
}

/** One finished run row of the last 24 hours as the port reads it. */
interface RecentRunRow {
  agent_id: string;
  native_issue_id: string | null;
  created_at: Date | string;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value: Date | string | null): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): the effective pheromone strength of
 * one queue row — priority rank and aging folded into the single number the
 * queue orders by. Higher = closer to the top of the queue. The aging term is
 * the seconds the task has waited, scaled by the priority weight; a critical
 * task ages 8× faster than a low one, exactly the shape design §2.3 gives the
 * evaporating signal. Rows without a parseable `created_at` wait zero seconds.
 */
export function swarmQueueEff(
  row: { priority: string | null; createdAt: Date | string | null },
  nowMs: number,
): number {
  const createdMs = Date.parse(String(row.createdAt ?? ""));
  const waitedSec = Number.isNaN(createdMs)
    ? 0
    : Math.max(0, Math.round((nowMs - createdMs) / 1000));
  const weight = PRIORITY_WEIGHT[row.priority?.toLowerCase?.() ?? ""] ?? 1;
  return weight * waitedSec;
}

/** Priority weights of the pheromone aging term (design §5.3). */
const PRIORITY_WEIGHT: Record<string, number> = { critical: 8, high: 4, medium: 2, low: 1 };

/**
 * Order queue candidates the way the swarm orders them: the highest effective
 * pheromone strength first (priority × waiting time), ties broken by the
 * oldest blockedTransitionAt, then creation order. The supervisor's "top of
 * queue" must be the same task the next claim would take.
 */
export function orderQueueCandidates(
  rows: SwarmQueueCandidateRow[],
  nowMs: number = Date.now(),
): SwarmQueueCandidateRow[] {
  return [...rows].sort((a, b) => {
    const byEff = (b.eff ?? 0) - (a.eff ?? 0);
    if (byEff !== 0) return byEff;
    const aBlocked = a.blockedTransitionAt ? Date.parse(a.blockedTransitionAt) : Number.POSITIVE_INFINITY;
    const bBlocked = b.blockedTransitionAt ? Date.parse(b.blockedTransitionAt) : Number.POSITIVE_INFINITY;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

export function swarmSupervisorView(
  port: SwarmSupervisorReadPort,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
) {
  const settings = readSwarmSupervisorSettings(env);

  async function overview(companyId: string): Promise<SwarmSupervisorOverview> {
    const generatedAt = new Date(now()).toISOString();
    const enabled = await port.claimEnabled();
    // 1.6.1 (SWARM-SETTINGS-UI): the source map is reported even when the
    // swarm is off — that is exactly when the operator wants to know whether
    // the UI or the environment is holding it off.
    const settingSources = await port.settingSources();
    if (!enabled) {
      return {
        enabled: false,
        generatedAt,
        leaseTtlSec: null,
        maxActiveTasksPerAgent: null,
        settingSources,
        totals: { queued: 0, activeClaims: 0, expiredClaims: 0, agentsWithClaims: 0, idleAgentsWithQueue: 0, freeAgentsWithQueue: 0 },
        roles: [],
        topQueue: [],
        matched: [],
        cooldown: [],
        warnings: [],
      };
    }
    const [ttl, maxActive, claimRows, queueRows, agents, liveRunAgents, matchedRows, recentRuns] =
      await Promise.all([
        port.leaseTtlSec(),
        port.maxActiveTasksPerAgent(),
        port.listClaimRows(companyId),
        port.listQueueRows(companyId),
        port.listAgents(companyId),
        port.liveRunAgentIds(companyId),
        port.listMatchedRows(companyId),
        port.listRecentRunTaskIds(companyId),
      ]);

    const nowMs = now().getTime();
    const agentById = new Map(agents.map((agent) => [agent.agent_id, agent]));
    const issueTitleById = new Map(queueRows.map((row) => [row.issue_id, row]));

    const liveClaims = claimRows.filter(
      (row) => toDate(row.released_at) === null && toDate(row.claim_id) !== undefined && row.claim_id,
    );
    const leaseByIssue = new Map<string, ClaimRow>();
    for (const claim of liveClaims) {
      if (toDate(claim.released_at) !== null) continue;
      const existing = leaseByIssue.get(claim.issue_id);
      if (!existing || Date.parse(String(claim.claimed_at)) > Date.parse(String(existing.claimed_at))) {
        leaseByIssue.set(claim.issue_id, claim);
      }
    }

    const claimedIssueIds = new Set(leaseByIssue.keys());
    const activeCountByAgent = new Map<string, number>();
    const expiredCountByAgent = new Map<string, number>();
    for (const claim of leaseByIssue.values()) {
      activeCountByAgent.set(claim.agent_id, (activeCountByAgent.get(claim.agent_id) ?? 0) + 1);
      if (Date.parse(String(claim.expires_at)) < nowMs) {
        expiredCountByAgent.set(claim.agent_id, (expiredCountByAgent.get(claim.agent_id) ?? 0) + 1);
      }
    }

    // Queued candidates are todo rows without a live lease; they are grouped
    // by the role of the agent expected to claim them (the role queue).
    const queueByRole = new Map<string, SwarmQueueCandidateRow[]>();
    const issueQueueRow = (row: QueueRow): SwarmQueueCandidateRow => ({
      issueId: row.issue_id,
      identifier: row.identifier,
      title: row.title,
      priority: row.priority,
      projectId: row.project_id,
      createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
      blockedTransitionAt: toIso(row.blocked_transition_at),
      // The real eff/nest are folded in by effOf below; these are the
      // pre-enrichment defaults (0 / the assignee).
      eff: 0,
      nestAgentId: row.assignee_agent_id ?? null,
    });

    const unclaimedRows = queueRows.filter((row) => !claimedIssueIds.has(row.issue_id));
    // myrmidon(1.6.5 SWARM-T4, design §5.3): the effective pheromone strength
    // of every candidate, computed once here. It is both a column of the
    // response (the owner reads it) and the ordering key of the queue.
    const effByIssue = new Map<string, number>();
    for (const row of unclaimedRows) {
      // QueueRow is snake_case (`created_at`); swarmQueueEff reads camelCase.
      effByIssue.set(
        row.issue_id,
        swarmQueueEff({ priority: row.priority, createdAt: row.created_at }, nowMs),
      );
    }
    const effOf = (row: QueueRow, issue: SwarmQueueCandidateRow): SwarmQueueCandidateRow => ({
      ...issue,
      eff: effByIssue.get(row.issue_id) ?? swarmQueueEff(issue, nowMs),
      nestAgentId: row.assignee_agent_id ?? null,
    });
    for (const row of unclaimedRows) {
      const issue = effOf(row, issueQueueRow(row));
      const roles = issueRoles(row, agentById);
      for (const role of roles) {
        const list = queueByRole.get(role) ?? [];
        if (list.length < settings.taskMax) {
          list.push(issue);
        }
        queueByRole.set(role, list);
      }
      // myrmidon(1.6.1 SWARM-IDLE-WAKE): an unassigned task belongs to every
      // role that could take it, the same membership the claim queue uses
      // (roleQueueRows: unassigned tasks are offered to every role). Without
      // this fan-out the supervisor's zero metric ("free agents with a
      // non-empty queue") cannot see the 03.10 shape — ready tasks with no
      // assignee and idle agents of the role that should claim them.
      if (!row.assignee_agent_id) {
        const rolesWithAgents = new Set(
          agents
            .map((agent) => agent.role)
            .filter((role): role is string => Boolean(role)),
        );
        for (const role of rolesWithAgents) {
          if (roles.includes(role)) continue;
          const list = queueByRole.get(role) ?? [];
          if (list.length < settings.taskMax) {
            list.push(issue);
          }
          queueByRole.set(role, list);
        }
      }
    }

    const leaseRowsByRole = new Map<string, SwarmClaimLeaseRow[]>();
    for (const claim of leaseByIssue.values()) {
      const agent = agentById.get(claim.agent_id);
      const role = agent?.role ?? "general";
      const queueMeta = issueTitleById.get(claim.issue_id);
      const expiresMs = Date.parse(String(claim.expires_at));
      const lease: SwarmClaimLeaseRow = {
        claimId: claim.claim_id,
        issueId: claim.issue_id,
        identifier: queueMeta?.identifier ?? null,
        title: queueMeta?.title ?? claim.issue_id,
        priority: queueMeta?.priority ?? "medium",
        agentId: claim.agent_id,
        agentName: agent?.agent_name ?? claim.agent_id,
        claimedAt: toIso(claim.claimed_at) ?? new Date(0).toISOString(),
        expiresAt: Number.isNaN(expiresMs)
          ? new Date(0).toISOString()
          : new Date(expiresMs).toISOString(),
        heartbeatAt: toIso(claim.heartbeat_at),
        expired: !Number.isNaN(expiresMs) && expiresMs < nowMs,
        secondsToExpiry: Number.isNaN(expiresMs)
          ? 0
          : Math.round((expiresMs - nowMs) / 1000),
      };
      const list = leaseRowsByRole.get(role) ?? [];
      list.push(lease);
      leaseRowsByRole.set(role, list);
    }

    const cap = typeof maxActive === "number" && maxActive > 0 ? maxActive : null;
    const roles: SwarmRoleOverview[] = [];
    for (const [role, queue] of queueByRole) {
      const ordered = orderQueueCandidates(queue, nowMs).slice(0, settings.taskMax);
      const claims = leaseRowsByRole.get(role) ?? [];
      const idleAgents: SwarmIdleAgentRow[] = agents
        .filter((agent) => agent.role === role)
        .filter((agent) => agent.status !== "paused" && agent.status !== "error")
        .filter((agent) => !liveRunAgents.has(agent.agent_id))
        .map((agent) => ({
          agentId: agent.agent_id,
          name: agent.agent_name,
          activeClaims: activeCountByAgent.get(agent.agent_id) ?? 0,
          atLimit: cap === null ? false : (activeCountByAgent.get(agent.agent_id) ?? 0) >= cap,
        }));
      roles.push({ role, queue: ordered, claims, idleAgents });
    }
    for (const [role, claims] of leaseRowsByRole) {
      if (!roles.some((entry) => entry.role === role)) {
        roles.push({ role, queue: [], claims, idleAgents: [] });
      }
    }
    roles.sort((a, b) => a.role.localeCompare(b.role));

    const totals = {
      queued: roles.reduce((sum, entry) => sum + entry.queue.length, 0),
      activeClaims: [...leaseByIssue.values()].length,
      expiredClaims: [...leaseByIssue.values()].filter(
        (claim) => Date.parse(String(claim.expires_at)) < nowMs,
      ).length,
      agentsWithClaims: new Set([...leaseByIssue.values()].map((claim) => claim.agent_id)).size,
      idleAgentsWithQueue: roles.reduce(
        (sum, entry) => sum + (entry.queue.length > 0 ? entry.idleAgents.length : 0),
        0,
      ),
      // myrmidon(1.6.1 SWARM-IDLE-WAKE): free agents at a non-empty queue,
      // the zero metric of the ticket. "Free" is the idle pass's own verdict
      // (no live run, not paused/error, under the ceiling), not the looser
      // idleAgents list: a capped agent is not free work the swarm can wake.
      freeAgentsWithQueue: roles.reduce(
        (sum, entry) =>
          sum +
          (entry.queue.length > 0
            ? entry.idleAgents.filter((agent) => !agent.atLimit).length
            : 0),
        0,
      ),
    };

    const topQueue = roles
      .flatMap((entry) =>
        entry.queue.map((issue) => ({
          issueId: issue.issueId,
          identifier: issue.identifier,
          title: issue.title,
          priority: issue.priority,
          role: entry.role,
          projectId: issue.projectId,
          createdAt: issue.createdAt,
        })),
      )
      .slice(0, settings.taskMax);

    // myrmidon(1.6.5 SWARM-T4, design §5.3): the recent board→agent matches.
    // The port filters by the frozen `issue.swarm_matched` action and orders
    // newest first; titles come from the queue rows we already hold (a
    // matched task is no longer queued, so fall back to the log's issue id).
    const matched: SwarmMatchedRow[] = matchedRows
      .slice(0, settings.taskMax)
      .map((row) => {
        const queueMeta = issueTitleById.get(row.issue_id);
        const agent = agentById.get(row.agent_id);
        return {
          at: toIso(row.at) ?? new Date(0).toISOString(),
          issueId: row.issue_id,
          identifier: queueMeta?.identifier ?? null,
          title: queueMeta?.title ?? row.issue_id,
          agentId: row.agent_id,
          agentName: agent?.agent_name ?? row.agent_id,
        };
      });

    // myrmidon(1.6.5 SWARM-T4, design §5.3): tasks in cooldown. The matching
    // core does not persist a cooldown ledger yet (T5 owns it), so the port
    // has nothing to read — the surface ships empty and lights up with T5.
    const cooldown: SwarmCooldownRow[] = [];

    // myrmidon(1.6.5 SWARM-T4, design §5.3): the three warnings. They are
    // computed from the same rows the totals come from, so the panel's
    // numbers and its warnings can never disagree.
    const warnings: SwarmWarningRow[] = [];
    for (const entry of roles) {
      if (entry.queue.length > 0 && entry.idleAgents.filter((agent) => !agent.atLimit).length === 0) {
        warnings.push({
          kind: "caste_without_agents",
          message: `caste ${entry.role}: ${entry.queue.length} queued task(s), no free agent`,
          caste: entry.role,
          issueCount: entry.queue.length,
        });
      }
    }
    // Tasks without a caste: unassigned todo candidates no agent role claims.
    // `issueRoles` returns [] when the assignee is unknown to the company; a
    // task whose fan-out found no agent role lands here too.
    const rolesWithQueues = new Set(roles.map((entry) => entry.role));
    const tasksWithoutCaste = unclaimedRows.filter((row) => {
      if (row.assignee_agent_id) {
        return issueRoles(row, agentById).length === 0;
      }
      return rolesWithQueues.size === 0;
    });
    if (tasksWithoutCaste.length > 0) {
      warnings.push({
        kind: "tasks_without_caste",
        message: `${tasksWithoutCaste.length} queued task(s) without a caste`,
        issueCount: tasksWithoutCaste.length,
      });
    }
    // Runs without a task in the last 24 hours — the anti-goal of the whole
    // feature: a run that burned budget and produced no task progress.
    const runsWithoutTask = recentRuns.filter((row) => !row.native_issue_id);
    if (runsWithoutTask.length > 0) {
      warnings.push({
        kind: "runs_without_task",
        message: `${runsWithoutTask.length} run(s) without a task in the last 24h`,
        runCount: runsWithoutTask.length,
      });
    }

    return {
      enabled: true,
      generatedAt,
      leaseTtlSec: ttl,
      maxActiveTasksPerAgent: maxActive,
      settingSources,
      totals,
      roles,
      topQueue,
      matched,
      cooldown,
      warnings,
    };
  }

  return { overview };
}

/**
 * Which role queues an unclaimed todo row belongs to. The queue is role-
 * scoped by the issue's assignee (part A's role filter): an assigned todo
 * queues for the assignee's role; an unassigned todo is attributed to no
 * role queue — the supervisor reports only queues it can attribute, it never
 * invents an assignment.
 */
function issueRoles(row: QueueRow, agentById: Map<string, AgentRow>): string[] {
  const assigneeId = row.assignee_agent_id;
  if (!assigneeId) return [];
  const agent = agentById.get(assigneeId);
  return agent ? [agent.role] : [];
}

/**
 * Build the read port over the live database. The claim table belongs to part
 * A; this port reads it with raw SQL so this module never imports part A's
 * schema module (it may not exist yet on this branch).
 */
export function createSwarmSupervisorDbPort(db: Db, env: NodeJS.ProcessEnv = process.env): SwarmSupervisorReadPort {
  const settings = readSwarmSupervisorSettings(env);
  return {
    async claimEnabled() {
      return readClaimEnabled(db, env);
    },
    async leaseTtlSec() {
      return readClaimSettingNumber(db, env, "MYRMIDON_SWARM_LEASE_TTL_SEC");
    },
    async maxActiveTasksPerAgent() {
      return readClaimSettingNumber(db, env, "MYRMIDON_SWARM_MAX_ACTIVE_TASKS");
    },
    async settingSources() {
      return readSwarmSettingSources(db, env);
    },
    async listClaimRows(companyId) {
      const rows = await db.execute(sql`
        SELECT id AS claim_id, issue_id, agent_id, claimed_at, expires_at, heartbeat_at, released_at
        FROM issue_claims
        WHERE company_id = ${companyId}
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as ClaimRow[];
    },
    async listQueueRows(companyId) {
      const rows = await db.execute(sql`
        SELECT id AS issue_id, identifier, title, priority, project_id, created_at, blocked_transition_at, assignee_agent_id
        FROM issues
        WHERE company_id = ${companyId}
          AND status = 'todo'
        ORDER BY created_at ASC
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as QueueRow[];
    },
    async listAgents(companyId) {
      const rows = await db.execute(sql`
        SELECT id AS agent_id, name AS agent_name, role, status
        FROM agents
        WHERE company_id = ${companyId}
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as AgentRow[];
    },
    async liveRunAgentIds(companyId) {
      const rows = await db.execute(sql`
        SELECT DISTINCT agent_id
        FROM heartbeat_runs
        WHERE company_id = ${companyId}
          AND status IN ('queued', 'running', 'scheduled_retry')
      `);
      const ids = (Array.isArray(rows) ? rows : []) as unknown as { agent_id: string }[];
      return new Set(ids.map((row) => row.agent_id));
    },
    async listMatchedRows(companyId) {
      // myrmidon(1.6.5 SWARM-T4, design §5.3): the match feed the T3 core
      // writes. The literal action string is the frozen contract; until T3
      // merges this query returns an empty list and the overview reports no
      // recent matches.
      const rows = await db.execute(sql`
        SELECT created_at AS at, entity_id AS issue_id, actor_id AS agent_id
        FROM activity_log
        WHERE company_id = ${companyId}
          AND entity_type = 'issue'
          AND action = ${SWARM_MATCHED_ACTION}
        ORDER BY created_at DESC
        LIMIT ${settings.taskMax}
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as MatchedActivityRow[];
    },
    async listRecentRunTaskIds(companyId) {
      const rows = await db.execute(sql`
        SELECT agent_id, native_issue_id, created_at
        FROM heartbeat_runs
        WHERE company_id = ${companyId}
          AND created_at > now() - interval '24 hours'
      `);
      return (Array.isArray(rows) ? rows : []) as unknown as RecentRunRow[];
    },
  };
}

/**
 * True when part A's claim module + table are present and the flag is on.
 *
 * 1.6.1 (SWARM-SETTINGS-UI): the flag is resolved by the shared resolver —
 * stored settings, then the env override, then the default — so the
 * supervisor reflects what the UI set without a restart. The env "off" still
 * wins outright (it is the forced override), matching the core's reading.
 */
async function readClaimEnabled(db: Db, env: NodeJS.ProcessEnv): Promise<boolean> {
  const forcedOff = env.MYRMIDON_SWARM_CLAIM_ENABLED?.trim().toLowerCase();
  if (forcedOff === "0" || forcedOff === "false" || forcedOff === "off" || forcedOff === "no") {
    return false;
  }
  const resolved = await readResolvedSwarmSettings(db, env);
  if (!resolved.settings.enabled) return false;
  try {
    const rows = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'issue_claims'
      ) AS table_exists
    `);
    const first = Array.isArray(rows) ? rows[0] : null;
    return Boolean(
      first &&
        typeof first === "object" &&
        (first as Record<string, unknown>).table_exists === true,
    );
  } catch {
    // The table belongs to part A; a database without it simply has no claims.
    return false;
  }
}

/**
 * 1.6.1 (SWARM-SETTINGS-UI): the resolved claim settings off the instance row,
 * through the same shared resolver the core uses, with the per-key source map.
 * Kept as one read so claimEnabled/leaseTtlSec/maxActiveTasksPerAgent (and the
 * source rendering below) cannot disagree about what is in force.
 */
interface ResolvedSwarmRow {
  settings: {
    enabled: boolean;
    leaseTtlSec: number;
    maxActiveTasks: number | null;
    sweepIntervalSec: number;
    p0Preemption: boolean;
    /** myrmidon(1.6.5 SWARM-T4): the pheromone subset (design §5.1). */
    pheromone: Record<string, number>;
  };
  sources: Record<string, string>;
}

async function readResolvedSwarmSettings(
  db: Db,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedSwarmRow> {
  try {
    const rows = await db.execute(sql`
      SELECT (general->'swarmClaim') AS swarm
      FROM instance_settings
      LIMIT 1
    `);
    const first = Array.isArray(rows) ? rows[0] : null;
    const stored =
      first && typeof first === "object"
        ? (first as Record<string, unknown>).swarm
        : undefined;
    const resolved = resolveSwarmClaimSettings({ stored, env });
    return {
      settings: resolved.settings,
      sources: resolved.sources as unknown as Record<string, string>,
    };
  } catch {
    const resolved = resolveSwarmClaimSettings({ env });
    return {
      settings: resolved.settings,
      sources: resolved.sources as unknown as Record<string, string>,
    };
  }
}

/**
 * 1.6.1 (SWARM-SETTINGS-UI): the supervisor overview tells the operator where
 * the effective values came from — the UI ("settings") or the environment
 * override ("env") — the way the settings page does. The sources map is keyed
 * by setting key (enabled, leaseTtlSec, maxActiveTasks, ...).
 */
export async function readSwarmSettingSources(
  db: Db,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const resolved = await readResolvedSwarmSettings(db, env);
  return resolved.sources;
}

async function readClaimSettingNumber(
  db: Db,
  env: NodeJS.ProcessEnv,
  envName: string,
): Promise<number | null> {
  // 1.6.1: the env value is the override; the stored settings are the primary
  // source, both resolved by the shared resolver in one read.
  const resolved = await readResolvedSwarmSettings(db, env);
  const storedKey = envName === "MYRMIDON_SWARM_LEASE_TTL_SEC" ? "leaseTtlSec" : "maxActiveTasks";
  const value = (resolved.settings as unknown as Record<string, unknown>)[storedKey];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return null;
}