// myrmidon(1.6-SWARM-CLAIM-B): unit tests of the supervisor surface.
//
// Part A's claim table may not be merged yet, so these tests run the real
// view/rebalance logic over an in-memory fake of the read port — no
// database, no part A import. Neutral ids only.

import { describe, expect, it, vi } from "vitest";
import {
  orderQueueCandidates,
  swarmQueueEff,
  swarmSupervisorView,
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
  unassignIssue: (companyId: string, issueId: string, agentId: string, now: Date) => Promise<boolean>;
  unassigned: { issueId: string; agentId: string }[];
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
  unassignError?: boolean;
  /** Called with every port write, in order, so a test can pin the sequence. */
  trace?: string[];
}): FakePort {
  const released: { claimId: string; reason: string }[] = [];
  const unassigned: { issueId: string; agentId: string }[] = [];
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
    async listMatchedRows() {
      return (input as { matched?: MatchedRow[] }).matched ?? [];
    },
    async listRecentRunTaskIds() {
      return (input as { recentRuns?: RecentRunRow[] }).recentRuns ?? [];
    },
    async releaseClaim(_companyId, claimId, reason) {
      released.push({ claimId, reason });
      input.trace?.push("release");
      return input.releaseResult ?? true;
    },
    async unassignIssue(_companyId, issueId, agentId) {
      input.trace?.push("unassign");
      if (input.unassignError) throw new Error("db down");
      unassigned.push({ issueId, agentId });
      return true;
    },
    released,
    unassigned,
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

describe("orderQueueCandidates", () => {
  it("orders by the effective pheromone strength: higher eff first", () => {
    const nowMs = NOW.getTime();
    const rows = [
      { issueId: "i-1", identifier: null, title: "a", priority: "low", projectId: null, createdAt: "2026-10-01T10:00:00.000Z", blockedTransitionAt: null, eff: 100, nestAgentId: null },
      { issueId: "i-2", identifier: null, title: "b", priority: "medium", projectId: null, createdAt: "2026-10-01T12:00:00.000Z", blockedTransitionAt: null, eff: 400, nestAgentId: null },
      { issueId: "i-3", identifier: null, title: "c", priority: "critical", projectId: null, createdAt: "2026-10-01T11:00:00.000Z", blockedTransitionAt: null, eff: 800, nestAgentId: null },
    ];
    const ordered = orderQueueCandidates(rows, nowMs).map((row) => row.issueId);
    expect(ordered).toEqual(["i-3", "i-2", "i-1"]);
  });

  it("breaks eff ties by the oldest blockedTransitionAt, then age", () => {
    const rows = [
      { issueId: "i-1", identifier: null, title: "a", priority: "medium", projectId: null, createdAt: "2026-10-01T10:00:00.000Z", blockedTransitionAt: "2026-10-02T15:00:00.000Z", eff: 100, nestAgentId: null },
      { issueId: "i-2", identifier: null, title: "b", priority: "medium", projectId: null, createdAt: "2026-10-01T12:00:00.000Z", blockedTransitionAt: "2026-10-02T14:00:00.000Z", eff: 100, nestAgentId: null },
      { issueId: "i-3", identifier: null, title: "c", priority: "medium", projectId: null, createdAt: "2026-10-01T09:00:00.000Z", blockedTransitionAt: null, eff: 100, nestAgentId: null },
    ];
    const ordered = orderQueueCandidates(rows, NOW.getTime()).map((row) => row.issueId);
    expect(ordered).toEqual(["i-2", "i-1", "i-3"]);
  });
});

describe("swarmQueueEff", () => {
  it("folds priority and waiting time into one number", () => {
    const nowMs = NOW.getTime();
    // A low task waiting 80s and a medium task waiting 40s both reach 80.
    const low = swarmQueueEff({ priority: "low", createdAt: new Date(nowMs - 80_000).toISOString() }, nowMs);
    const medium = swarmQueueEff({ priority: "medium", createdAt: new Date(nowMs - 40_000).toISOString() }, nowMs);
    expect(low).toBe(80);
    expect(medium).toBe(80);
    const critical = swarmQueueEff({ priority: "critical", createdAt: new Date(nowMs - 10_000).toISOString() }, nowMs);
    expect(critical).toBe(80);
  });

  it("never reports negative waiting for future timestamps", () => {
    const nowMs = NOW.getTime();
    expect(swarmQueueEff({ priority: "critical", createdAt: new Date(nowMs + 60_000).toISOString() }, nowMs)).toBe(0);
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
  const HOLDER = "44444444-4444-4444-8444-444444444444";
  const OTHER = "44444444-4444-4444-8444-444444444445";
  const CLAIM = "33333333-3333-4333-8333-333333333333";
  const ISSUE = "11111111-1111-4111-8111-111111111111";

  function deps(
    port: ReturnType<typeof fakePort>,
    opts: { match?: (issueId: string) => Promise<{ agentId: string } | null>; trace?: string[] } = {},
  ): SwarmRebalanceDeps & { matchIssue: ReturnType<typeof vi.fn> } {
    const matchIssue = vi.fn(async (issueId: string) => {
      opts.trace?.push("match");
      return opts.match ? opts.match(issueId) : { agentId: OTHER };
    });
    return { port, matchIssue, now: () => NOW };
  }

  it("releases the lease, takes the owner off the task, then hands the task to the matcher and audits", async () => {
    const trace: string[] = [];
    const port = fakePort({ claims: [claim()], issues: [issue()], agents: [agent()], trace });
    const logActivity = vi.fn<(input: { action: string }) => Promise<void>>(async () => {});
    const d = deps(port, { trace });
    const result = await releaseLeaseForRebalance({ ...d, logActivity }, COMPANY_ID, CLAIM);
    expect(result.released).toBe(true);
    // The agent the matcher paired is reported; the holder is not asked again.
    expect(result.wokenAgentId).toBe(OTHER);
    expect(port.released).toEqual([{ claimId: CLAIM, reason: "supervisor_rebalance" }]);
    expect(port.unassigned).toEqual([{ issueId: ISSUE, agentId: HOLDER }]);
    expect(d.matchIssue).toHaveBeenCalledWith(ISSUE);
    // Order is the contract: the matcher only sees a task that has no owner.
    expect(trace).toEqual(["release", "unassign", "match"]);
    expect(logActivity.mock.calls[0]?.[0]?.action).toBe("issue.swarm_claim_supervisor_release");
  });

  it("does not pick the next agent by load: nobody is woken when the matcher pairs nobody", async () => {
    // Two idle agents of the role exist; the old shape woke the less loaded one
    // directly. The matcher is the only path now, so a null pair means no wake.
    const port = fakePort({
      claims: [claim()],
      issues: [issue()],
      agents: [agent(), agent({ agent_id: OTHER, agent_name: "agent-b" })],
    });
    const d = deps(port, { match: async () => null });
    const result = await releaseLeaseForRebalance(d, COMPANY_ID, CLAIM);
    expect(result.released).toBe(true);
    expect(result.wokenAgentId).toBeNull();
    expect(d.matchIssue).toHaveBeenCalledTimes(1);
  });

  it("rotates: the task is offered to the matcher with no owner, so the holder is not kept", async () => {
    const port = fakePort({ claims: [claim()], issues: [issue()], agents: [agent()] });
    const seenOwners: Array<string | null> = [];
    const d = deps(port, {
      match: async () => {
        // At match time the holder has already been taken off.
        seenOwners.push(port.unassigned.length > 0 ? null : HOLDER);
        return { agentId: OTHER };
      },
    });
    await releaseLeaseForRebalance(d, COMPANY_ID, CLAIM);
    expect(seenOwners).toEqual([null]);
  });

  it("a refused unassign still matches (the periodic pass never wakes anyone for a foreign task)", async () => {
    const port = fakePort({ claims: [claim()], issues: [issue()], agents: [agent()], unassignError: true });
    const d = deps(port);
    const result = await releaseLeaseForRebalance(d, COMPANY_ID, CLAIM);
    expect(result.released).toBe(true);
    expect(d.matchIssue).toHaveBeenCalled();
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

  it("survives a matcher failure: released stays true, wokenAgentId null", async () => {
    const port = fakePort({ claims: [claim()], issues: [issue()], agents: [agent()] });
    const d = deps(port, {
      match: async () => {
        throw new Error("wake refused");
      },
    });
    const result = await releaseLeaseForRebalance(d, COMPANY_ID, CLAIM);
    expect(result.released).toBe(true);
    expect(result.wokenAgentId).toBeNull();
  });

  it("reports released:false and touches neither the owner nor the matcher when the release path declines", async () => {
    const port = fakePort({ claims: [claim()], releaseResult: false });
    const d = deps(port);
    const result = await releaseLeaseForRebalance(d, COMPANY_ID, CLAIM);
    expect(result.released).toBe(false);
    expect(port.unassigned).toEqual([]);
    expect(d.matchIssue).not.toHaveBeenCalled();
  });

  it("with the swarm off (no matcher wired) the release stands alone", async () => {
    const port = fakePort({ claims: [claim()], issues: [issue()], agents: [agent()] });
    const result = await releaseLeaseForRebalance({ port, now: () => NOW }, COMPANY_ID, CLAIM);
    expect(result.released).toBe(true);
    expect(result.wokenAgentId).toBeNull();
  });
});

// myrmidon(1.6.5 SWARM-T4, design §5.3): the overview surface — matches,
// warnings and the eff-ordered queue.
describe("swarmSupervisorView.overview (T4 surfaces)", () => {
  it("reports the queue ordered by eff with the nest and waiting time", async () => {
    const port = fakePort({
      issues: [
        issue({
          issue_id: "11111111-1111-4111-8111-111111111121",
          identifier: "TST-10",
          title: "Fresh critical",
          priority: "critical",
          created_at: "2026-10-02T15:00:00.000Z",
        }),
        issue({
          issue_id: "11111111-1111-4111-8111-111111111122",
          identifier: "TST-11",
          title: "Old medium",
          priority: "medium",
          created_at: "2026-10-01T00:00:00.000Z",
          assignee_agent_id: "44444444-4444-4444-8444-444444444444",
        }),
      ],
      agents: [agent()],
    });
    const view = swarmSupervisorView(port, {}, () => NOW);
    const overview = await view.overview(COMPANY_ID);
    const engineer = overview.roles.find((role) => role.role === "engineer");
    expect(engineer).toBeDefined();
    // Fresh critical (30 min × 8 = 14400) beats old medium (~39.5h × 2 ≈ 284000)?
    // No: the old medium task waited far longer, so its eff is higher.
    const ordered = engineer?.queue.map((row) => row.identifier);
    expect(ordered).toEqual(["TST-11", "TST-10"]);
    // eff is a response column: critical fresh = 8 * 1800.
    const fresh = engineer?.queue.find((row) => row.identifier === "TST-10");
    expect(fresh?.eff).toBe(8 * 1800);
    // The nest of the assigned medium task is its assignee.
    const assigned = engineer?.queue.find((row) => row.identifier === "TST-11");
    expect(assigned?.nestAgentId).toBe("44444444-4444-4444-8444-444444444444");
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
