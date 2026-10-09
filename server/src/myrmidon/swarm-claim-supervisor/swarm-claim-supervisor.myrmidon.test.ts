// myrmidon(1.6-SWARM-CLAIM-B): unit tests of the supervisor surface.
//
// Part A's claim table may not be merged yet, so these tests run the real
// view/rebalance logic over an in-memory fake of the read port — no
// database, no part A import. Neutral ids only.

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PHEROMONE_DYNAMICS, type PheromoneDynamicsSettings } from "@paperclipai/shared";
import {
  orderQueueCandidates,
  queueRowEff,
  swarmSupervisorView,
  type SwarmQueueCandidateRow,
  type SwarmSupervisorReadPort,
} from "./view.js";
import {
  ClaimNotLiveError,
  ClaimNotFoundError,
  releaseLeaseForRebalance,
  type SwarmRebalanceDeps,
} from "./rebalance.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** The read port plus the release write, faked in memory. */
interface FakePort extends SwarmSupervisorReadPort {
  releaseClaim: (
    companyId: string,
    claimId: string,
    reason: string,
    now: Date,
  ) => Promise<boolean>;
  released: { claimId: string; reason: string }[];
}

interface FakeClaim {
  claim_id: string;
  issue_id: string;
  agent_id: string;
  claimed_at: string;
  expires_at: string;
  heartbeat_at: string | null;
  released_at: string | null;
}

interface FakeIssue {
  issue_id: string;
  identifier: string | null;
  title: string;
  priority: string;
  project_id: string | null;
  created_at: string;
  blocked_transition_at: string | null;
}

/** Queued rows carry the assignee so the role queue can be attributed. */
interface FakeQueueRow extends FakeIssue {
  assignee_agent_id?: string | null;
  /** 1.6.5 (F-27): the strength on the task card; absent reads as 0. */
  pheromone_strength?: number | null;
  failed_runs_since_last_change?: number | null;
}

interface FakeAgent {
  agent_id: string;
  agent_name: string;
  role: string;
  status: string;
}

/** myrmidon(1.6.5 SWARM-T4): fake `issue.swarm_matched` activity rows. */
interface MatchedRow {
  at: string;
  issue_id: string;
  agent_id: string;
}

/** myrmidon(1.6.5 SWARM-T4): fake recent run rows (task id may be null). */
interface RecentRunRow {
  agent_id: string;
  native_issue_id: string | null;
  created_at: string;
}

const NOW = new Date("2026-10-02T15:30:00.000Z");

function fakePort(input: {
  enabled?: boolean;
  ttl?: number | null;
  maxActive?: number | null;
  claims?: FakeClaim[];
  issues?: FakeQueueRow[];
  agents?: FakeAgent[];
  liveRunAgents?: string[];
  /** myrmidon(1.6.5 SWARM-T4): the fake match feed and recent runs. */
  matched?: MatchedRow[];
  recentRuns?: RecentRunRow[];
  releaseResult?: boolean;
  /** 1.6.5 (F-27): the resolved `pheromone` dynamics; absent = the design defaults. */
  dynamics?: PheromoneDynamicsSettings;
  p0Preemption?: boolean;
}): FakePort {
  const released: { claimId: string; reason: string }[] = [];
  const port: FakePort = {
    async claimEnabled() {
      return input.enabled ?? true;
    },
    async leaseTtlSec() {
      return input.ttl ?? null;
    },
    async maxActiveTasksPerAgent() {
      return input.maxActive ?? null;
    },
    // myrmidon(1.6.1 SWARM-SETTINGS-UI): the fake answers the source map the
    // real DB port reads from the instance settings row.
    async settingSources() {
      return (input as { sources?: Record<string, string> }).sources ?? {};
    },
    async listClaimRows() {
      return (input.claims ?? []) as unknown as FakeClaim[];
    },
    async listQueueRows() {
      return (input.issues ?? []) as unknown as FakeQueueRow[];
    },
    async listAgents() {
      return (input.agents ?? []) as unknown as FakeAgent[];
    },
    async liveRunAgentIds() {
      return new Set(input.liveRunAgents ?? []);
    },
    async pheromoneDynamics() {
      return input.dynamics ?? DEFAULT_PHEROMONE_DYNAMICS;
    },
    async p0Preemption() {
      return input.p0Preemption ?? true;
    },
    async listMatchedRows() {
      return (input as { matched?: MatchedRow[] }).matched ?? [];
    },
    async listRecentRunTaskIds() {
      return (input as { recentRuns?: RecentRunRow[] }).recentRuns ?? [];
    },
    async releaseClaim(_companyId, claimId, reason) {
      released.push({ claimId, reason });
      return input.releaseResult ?? true;
    },
    released,
  };
  return port;
}

function issue(overrides: Partial<FakeQueueRow> = {}): FakeQueueRow {
  return {
    issue_id: "11111111-1111-4111-8111-111111111111",
    identifier: "TST-1",
    title: "First queued task",
    priority: "medium",
    project_id: null,
    created_at: "2026-10-01T10:00:00.000Z",
    blocked_transition_at: null,
    assignee_agent_id: null,
    ...overrides,
  };
}

function claim(overrides: Partial<FakeClaim> = {}): FakeClaim {
  return {
    claim_id: "33333333-3333-4333-8333-333333333333",
    issue_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "44444444-4444-4444-8444-444444444444",
    claimed_at: "2026-10-02T15:00:00.000Z",
    expires_at: "2026-10-02T16:00:00.000Z",
    heartbeat_at: "2026-10-02T15:20:00.000Z",
    released_at: null,
    ...overrides,
  };
}

function agent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    agent_id: "44444444-4444-4444-8444-444444444444",
    agent_name: "agent-a",
    role: "engineer",
    status: "idle",
    ...overrides,
  };
}

function candidate(overrides: Partial<SwarmQueueCandidateRow> & { issueId: string }): SwarmQueueCandidateRow {
  return {
    identifier: null,
    title: overrides.issueId,
    priority: "medium",
    projectId: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    blockedTransitionAt: null,
    eff: 0,
    pheromoneStrength: 0,
    nestAgentId: null,
    ...overrides,
  };
}

describe("orderQueueCandidates", () => {
  it("P0 first, then the effective strength descending", () => {
    const rows = [
      candidate({ issueId: "i-1", priority: "low", eff: 100 }),
      candidate({ issueId: "i-2", priority: "medium", eff: 400 }),
      candidate({ issueId: "i-3", priority: "critical", eff: 5 }),
      candidate({ issueId: "i-4", priority: "high", eff: 900 }),
    ];
    expect(orderQueueCandidates(rows).map((row) => row.issueId)).toEqual(["i-3", "i-4", "i-2", "i-1"]);
    // With P0 preemption off the strength alone decides.
    expect(orderQueueCandidates(rows, { p0Preemption: false }).map((row) => row.issueId)).toEqual([
      "i-4",
      "i-2",
      "i-1",
      "i-3",
    ]);
  });

  it("breaks eff ties by the oldest blockedTransitionAt, then age, then id", () => {
    const rows = [
      candidate({ issueId: "i-1", eff: 100, createdAt: "2026-10-01T10:00:00.000Z", blockedTransitionAt: "2026-10-02T15:00:00.000Z" }),
      candidate({ issueId: "i-2", eff: 100, createdAt: "2026-10-01T12:00:00.000Z", blockedTransitionAt: "2026-10-02T14:00:00.000Z" }),
      candidate({ issueId: "i-3", eff: 100, createdAt: "2026-10-01T09:00:00.000Z" }),
      candidate({ issueId: "i-5", eff: 100, createdAt: "2026-10-01T09:00:00.000Z" }),
      candidate({ issueId: "i-4", eff: 100, createdAt: "2026-10-01T09:00:00.000Z" }),
    ];
    expect(orderQueueCandidates(rows).map((row) => row.issueId)).toEqual(["i-2", "i-1", "i-3", "i-4", "i-5"]);
  });
});

describe("queueRowEff", () => {
  const H = 3_600_000;
  it("is the strength plus the aging minus the failure penalty, from the dynamics", () => {
    const row = { pheromoneStrength: 30, createdAt: new Date(NOW.getTime() - 72 * H).toISOString(), failedRunsSinceLastChange: 1 };
    // 30 + 3 days of aging (+3) - 10 = 23 with the defaults.
    expect(queueRowEff(row, DEFAULT_PHEROMONE_DYNAMICS, NOW)).toBe(23);
    // The knobs are settings: failPenalty 0, agingStep 2 per 12h, cap 100 -> 30 + 12.
    expect(
      queueRowEff(row, { agingStepHours: 12, agingStep: 2, agingCap: 100, failPenalty: 0 }, NOW),
    ).toBe(42);
  });
});

describe("swarmSupervisorView.overview", () => {
  it("answers enabled:false with empty totals when the claim machinery is off", async () => {
    const view = swarmSupervisorView(fakePort({ enabled: false }), {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    expect(overview.enabled).toBe(false);
    expect(overview.roles).toEqual([]);
    expect(overview.totals.queued).toBe(0);
  });

  it("reports the role queue, live lease, expired lease and idle agents", async () => {
    const port = fakePort({
      ttl: 3600,
      maxActive: 2,
      claims: [
        claim(),
        claim({
          claim_id: "33333333-3333-4333-8333-333333333334",
          issue_id: "11111111-1111-4111-8111-111111111112",
          agent_id: "44444444-4444-4444-8444-444444444445",
          expires_at: "2026-10-02T15:10:00.000Z",
        }),
        claim({
          claim_id: "33333333-3333-4333-8333-333333333335",
          issue_id: "11111111-1111-4111-8111-111111111113",
          agent_id: "44444444-4444-4444-8444-444444444444",
          released_at: "2026-10-02T15:25:00.000Z",
        }),
      ],
      issues: [
        issue(),
        issue({
          issue_id: "11111111-1111-4111-8111-111111111112",
          identifier: "TST-2",
          title: "Claimed task",
        }),
        issue({
          issue_id: "11111111-1111-4111-8111-111111111114",
          identifier: "TST-3",
          title: "Unclaimed queued task",
          priority: "critical",
          assignee_agent_id: "44444444-4444-4444-8444-444444444444",
        }),
      ],
      agents: [
        agent(),
        agent({
          agent_id: "44444444-4444-4444-8444-444444444445",
          agent_name: "agent-b",
        }),
        agent({
          agent_id: "44444444-4444-4444-8444-444444444446",
          agent_name: "agent-c",
        }),
      ],
      liveRunAgents: ["44444444-4444-4444-8444-444444444446"],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);

    expect(overview.enabled).toBe(true);
    expect(overview.leaseTtlSec).toBe(3600);
    expect(overview.maxActiveTasksPerAgent).toBe(2);
    // The released history row is not a live lease.
    expect(overview.totals.activeClaims).toBe(2);
    expect(overview.totals.expiredClaims).toBe(1);
    expect(overview.totals.agentsWithClaims).toBe(2);
    // Only the unclaimed critical task is queued; the two leased tasks are not.
    expect(overview.totals.queued).toBe(1);
    // agent-a and agent-b are idle with a non-empty role queue; agent-c has a
    // live run and is not idle.
    expect(overview.totals.idleAgentsWithQueue).toBe(2);

    const engineer = overview.roles.find((role) => role.role === "engineer");
    expect(engineer).toBeDefined();
    expect(engineer?.queue.map((row) => row.identifier)).toEqual(["TST-3"]);
    expect(engineer?.claims).toHaveLength(2);
    const expired = engineer?.claims.find((row) => row.claimId === "33333333-3333-4333-8333-333333333334");
    expect(expired?.expired).toBe(true);
    expect(expired?.agentName).toBe("agent-b");
    const live = engineer?.claims.find((row) => row.claimId === "33333333-3333-4333-8333-333333333333");
    expect(live?.expired).toBe(false);
    expect(live?.secondsToExpiry).toBe(1800);
    expect(engineer?.idleAgents.map((row) => row.name)).toEqual(["agent-a", "agent-b"]);
    expect(overview.topQueue[0]?.priority).toBe("critical");
  });
});

describe("releaseLeaseForRebalance", () => {
  function deps(port: ReturnType<typeof fakePort>, opts: { wakeError?: boolean } = {}): SwarmRebalanceDeps {
    return {
      port,
      enqueueWakeup: vi.fn(async () => {
        if (opts.wakeError) throw new Error("wake refused");
        return { queued: true };
      }),
      now: () => NOW,
    };
  }

  it("releases a live lease, wakes the next idle agent of the role and audits", async () => {
    const port = fakePort({
      claims: [claim()],
      issues: [issue()],
      agents: [
        agent(),
        agent({
          agent_id: "44444444-4444-4444-8444-444444444445",
          agent_name: "agent-b",
        }),
      ],
      liveRunAgents: ["44444444-4444-4444-8444-444444444444"],
    });
    const logActivity = vi.fn<(input: { action: string }) => Promise<void>>(async () => {});
    const result = await releaseLeaseForRebalance(
      { ...deps(port), logActivity },
      COMPANY_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(result.released).toBe(true);
    expect(result.wokenAgentId).toBe("44444444-4444-4444-8444-444444444445");
    expect(port.released).toEqual([
      { claimId: "33333333-3333-4333-8333-333333333333", reason: "supervisor_rebalance" },
    ]);
    const logged = logActivity.mock.calls[0]?.[0];
    expect(logged?.action).toBe("issue.swarm_claim_supervisor_release");
  });

  it("404s on an unknown claim and 409s on a released or expired claim", async () => {
    const port = fakePort({
      claims: [
        claim({
          claim_id: "33333333-3333-4333-8333-333333333334",
          released_at: "2026-10-02T15:00:00.000Z",
        }),
        claim({
          claim_id: "33333333-3333-4333-8333-333333333335",
          expires_at: "2026-10-02T15:00:00.000Z",
        }),
      ],
    });
    await expect(
      releaseLeaseForRebalance(deps(port), COMPANY_ID, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(ClaimNotFoundError);
    await expect(
      releaseLeaseForRebalance(deps(port), COMPANY_ID, "33333333-3333-4333-8333-333333333334"),
    ).rejects.toBeInstanceOf(ClaimNotLiveError);
    await expect(
      releaseLeaseForRebalance(deps(port), COMPANY_ID, "33333333-3333-4333-8333-333333333335"),
    ).rejects.toBeInstanceOf(ClaimNotLiveError);
  });

  it("survives a refused wake: released stays true, wokenAgentId null", async () => {
    const port = fakePort({ claims: [claim()], issues: [issue()], agents: [agent()] });
    const result = await releaseLeaseForRebalance(
      deps(port, { wakeError: true }),
      COMPANY_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(result.released).toBe(true);
    expect(result.wokenAgentId).toBeNull();
  });

  it("reports released:false when the release path declines", async () => {
    const port = fakePort({ claims: [claim()], releaseResult: false });
    const result = await releaseLeaseForRebalance(
      deps(port),
      COMPANY_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(result.released).toBe(false);
  });
});

// myrmidon(1.6.5 SWARM-T4, design §5.3): the overview surface — matches,
// warnings and the eff-ordered queue.
describe("swarmSupervisorView.overview (T4 surfaces)", () => {
  it("reports the queue ordered by the effective pheromone strength with the nest", async () => {
    const strongFresh = "11111111-1111-4111-8111-111111111121";
    const weakOldA = "11111111-1111-4111-8111-111111111122";
    const weakOldB = "11111111-1111-4111-8111-111111111123";
    const port = fakePort({
      issues: [
        issue({
          issue_id: weakOldA,
          identifier: "TST-11",
          title: "Old weak A",
          created_at: "2026-09-20T00:00:00.000Z",
          pheromone_strength: 10,
          assignee_agent_id: "44444444-4444-4444-8444-444444444444",
        }),
        issue({
          issue_id: weakOldB,
          identifier: "TST-12",
          title: "Old weak B",
          created_at: "2026-09-21T00:00:00.000Z",
          pheromone_strength: 10,
        }),
        issue({
          issue_id: strongFresh,
          identifier: "TST-10",
          title: "Fresh strong",
          created_at: "2026-10-02T15:00:00.000Z",
          pheromone_strength: 100,
        }),
      ],
      agents: [agent()],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    const engineer = overview.roles.find((role) => role.role === "engineer");
    expect(engineer).toBeDefined();
    // A strong fresh task is ahead of the old weak ones (aging is capped at +5).
    expect(engineer?.queue.map((row) => row.identifier)).toEqual(["TST-10", "TST-11", "TST-12"]);
    const fresh = engineer?.queue.find((row) => row.identifier === "TST-10");
    expect(fresh?.pheromoneStrength).toBe(100);
    expect(fresh?.eff).toBe(100);
    // eff = strength + capped aging: 10 + 5.
    expect(engineer?.queue.find((row) => row.identifier === "TST-11")?.eff).toBe(15);
    // The nest of the assigned task is its assignee.
    expect(engineer?.queue.find((row) => row.identifier === "TST-11")?.nestAgentId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(overview.topQueue[0]?.identifier).toBe("TST-10");
  });

  it("a change of the strength on the card changes the order; the settings apply on the next read", async () => {
    const a = "11111111-1111-4111-8111-111111111131";
    const b = "11111111-1111-4111-8111-111111111132";
    const rows = [
      issue({ issue_id: a, identifier: "TST-20", created_at: "2026-10-02T10:00:00.000Z", pheromone_strength: 10, assignee_agent_id: null }),
      issue({ issue_id: b, identifier: "TST-21", created_at: "2026-10-02T11:00:00.000Z", pheromone_strength: 10, assignee_agent_id: null }),
    ];
    const first = await swarmSupervisorView(fakePort({ issues: rows, agents: [agent()] }), {}, () => NOW).overview(COMPANY_ID);
    expect(first.roles[0]?.queue.map((row) => row.identifier)).toEqual(["TST-20", "TST-21"]);
    // The owner raises the second task on its card: it moves to the top.
    rows[1] = { ...rows[1]!, pheromone_strength: 50 };
    const second = await swarmSupervisorView(fakePort({ issues: rows, agents: [agent()] }), {}, () => NOW).overview(COMPANY_ID);
    expect(second.roles[0]?.queue.map((row) => row.identifier)).toEqual(["TST-21", "TST-20"]);
    // A failure penalty from the settings read on the next overview drops the top task again.
    rows[1] = { ...rows[1]!, failed_runs_since_last_change: 5 };
    const third = await swarmSupervisorView(fakePort({ issues: rows, agents: [agent()] }), {}, () => NOW).overview(COMPANY_ID);
    expect(third.roles[0]?.queue.map((row) => row.identifier)).toEqual(["TST-20", "TST-21"]);
    // And the dynamics are read from the port on every call (settings without restart).
    const noPenalty = await swarmSupervisorView(
      fakePort({
        issues: rows,
        agents: [agent()],
        dynamics: { ...DEFAULT_PHEROMONE_DYNAMICS, failPenalty: 0 },
      }),
      {},
      () => NOW,
    ).overview(COMPANY_ID);
    expect(noPenalty.roles[0]?.queue.map((row) => row.identifier)).toEqual(["TST-21", "TST-20"]);
  });

  it("reports the recent matches from the activity feed, newest first", async () => {
    const port = fakePort({
      matched: [
        { at: "2026-10-02T15:00:00.000Z", issue_id: "11111111-1111-4111-8111-111111111131", agent_id: "44444444-4444-4444-8444-444444444444" },
        { at: "2026-10-02T14:00:00.000Z", issue_id: "11111111-1111-4111-8111-111111111132", agent_id: "44444444-4444-4444-8444-444444444444" },
      ],
      agents: [agent()],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    expect(overview.matched.map((row) => row.issueId)).toEqual([
      "11111111-1111-4111-8111-111111111131",
      "11111111-1111-4111-8111-111111111132",
    ]);
    expect(overview.matched[0]?.agentName).toBe("agent-a");
  });

  it("answers an empty match feed and cooldown until the cores land", async () => {
    const port = fakePort({ agents: [agent()] });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    expect(overview.matched).toEqual([]);
    expect(overview.cooldown).toEqual([]);
  });

  it("warns: caste with queued tasks and no free agent", async () => {
    const port = fakePort({
      issues: [
        issue({
          issue_id: "11111111-1111-4111-8111-111111111141",
          identifier: "TST-20",
          title: "Queued task",
          assignee_agent_id: "44444444-4444-4444-8444-444444444444",
        }),
      ],
      // One agent, but capped: not free work the swarm can wake.
      agents: [agent()],
      liveRunAgents: ["44444444-4444-4444-8444-444444444444"],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    const warning = overview.warnings.find((w) => w.kind === "caste_without_agents");
    expect(warning).toBeDefined();
    expect(warning?.caste).toBe("engineer");
    expect(warning?.issueCount).toBe(1);
  });

  it("warns: tasks without a caste (unknown assignee)", async () => {
    const port = fakePort({
      issues: [
        issue({
          issue_id: "11111111-1111-4111-8111-111111111151",
          identifier: "TST-21",
          title: "Orphan task",
          assignee_agent_id: "99999999-9999-4999-8999-999999999999",
        }),
      ],
      agents: [agent()],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    const warning = overview.warnings.find((w) => w.kind === "tasks_without_caste");
    expect(warning).toBeDefined();
    expect(warning?.issueCount).toBe(1);
  });

  it("warns: runs without a task in the last 24h", async () => {
    const port = fakePort({
      agents: [agent()],
      recentRuns: [
        { agent_id: "44444444-4444-4444-8444-444444444444", native_issue_id: null, created_at: "2026-10-02T10:00:00.000Z" },
        { agent_id: "44444444-4444-4444-8444-444444444444", native_issue_id: "11111111-1111-4111-8111-111111111111", created_at: "2026-10-02T11:00:00.000Z" },
      ],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    const warning = overview.warnings.find((w) => w.kind === "runs_without_task");
    expect(warning).toBeDefined();
    expect(warning?.runCount).toBe(1);
  });

  it("stays silent when everything is healthy", async () => {
    const port = fakePort({
      issues: [
        issue({
          issue_id: "11111111-1111-4111-8111-111111111161",
          identifier: "TST-22",
          title: "Healthy task",
          assignee_agent_id: "44444444-4444-4444-8444-444444444444",
        }),
      ],
      agents: [agent()],
      recentRuns: [
        { agent_id: "44444444-4444-4444-8444-444444444444", native_issue_id: "11111111-1111-4111-8111-111111111161", created_at: "2026-10-02T11:00:00.000Z" },
      ],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    expect(overview.warnings).toEqual([]);
  });
});
