// myrmidon(1.6.6 CLAIM-TRANSACTION): seeded PG load of project-scoped claims.
// A fixed PRNG seed shuffles both agent and task order without making failures
// depend on ambient randomness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agentCastes,
  agents,
  companies,
  createDb,
  issueClaims,
  issues,
  projectMemberships,
  projects,
} from "@myrmidon/db";
import { resolveSwarmClaimSettings } from "@myrmidon/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { matchAgent, type SwarmMatcherDeps } from "./matcher.js";

const SEED = 0x5eed9182;
const NOW = new Date("2026-10-25T00:00:00.000Z");
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function stableUuid(namespace: number, index: number): string {
  return `${namespace.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function seededScenario(seed: number) {
  const companyId = stableUuid(1, 0);
  const projectIds = Array.from({ length: 5 }, (_, index) => stableUuid(2, index));
  const engineerIds = Array.from({ length: 20 }, (_, index) => stableUuid(3, index));
  const reviewerId = stableUuid(4, 0);
  const taskIds = Array.from({ length: 100 }, (_, index) => stableUuid(5, index));
  const random = seededRandom(seed);
  const order = shuffled(engineerIds, random);
  const shuffledTasks = shuffled(taskIds, random);
  const rounds = Array.from({ length: 5 }, () => shuffled(order, random));
  return { companyId, projectIds, engineerIds, reviewerId, taskIds, order, shuffledTasks, rounds };
}

describeDatabase("swarm cross-project claim load", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const { companyId, projectIds, engineerIds, reviewerId, taskIds } = seededScenario(SEED);
  const projectByTask = new Map<string, string>();
  const claimSettings = resolveSwarmClaimSettings({ env: {} }).settings;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-cross-project-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Cross project load",
      issuePrefix: `XP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agentCastes).values([
      { companyId, key: "engineer", nameEn: "Engineer", swarmEligible: true, isDefault: true },
      { companyId, key: "reviewer", nameEn: "Reviewer", swarmEligible: true },
    ]);
    await db.insert(projects).values(projectIds.map((id, index) => ({
      id, companyId, name: `Load project ${index}`, status: "active",
    })));
    await db.insert(agents).values([
      ...engineerIds.map((id, index) => ({
        id,
        companyId,
        name: `engineer-${index}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        metadata: {},
      })),
      {
        id: reviewerId, companyId, name: "reviewer", role: "reviewer", status: "idle",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {}, metadata: {},
      },
    ]);
    for (let p = 0; p < projectIds.length; p += 1) {
      await db.insert(projectMemberships).values([
        ...engineerIds.slice(p * 4, p * 4 + 4).map((userId) => ({
          companyId, projectId: projectIds[p]!, userId, state: "joined",
        })),
        ...(p === 0 ? [{ companyId, projectId: projectIds[p]!, userId: reviewerId, state: "joined" }] : []),
      ]);
    }
    await db.insert(issues).values(taskIds.map((id, index) => {
      const projectId = projectIds[index % projectIds.length]!;
      projectByTask.set(id, projectId);
      return {
        id, companyId, projectId, title: `Load task ${index}`, identifier: `XPL-${index}`,
        status: "todo", priority: "medium", casteKey: "engineer",
      };
    }));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  it("keeps randomized project claims scoped; seeded fixture and input order repeat exactly", async () => {
    const scenario = seededScenario(SEED);
    expect(seededScenario(SEED)).toEqual(scenario);
    await db.update(issues).set({ priority: "high" }).where(inArray(issues.id, scenario.shuffledTasks.slice(0, 35)));
    const deps = {
      db,
      heartbeat: { wakeup: async () => ({ queued: true }) },
      settings: { ...claimSettings, enabled: true, maxActiveTasks: 8 },
      hostGateOpen: true,
      now: NOW,
      casteDirectory: async () => [
        { key: "engineer", swarmEligible: true, maxActiveTasks: 8 },
        { key: "reviewer", swarmEligible: true, maxActiveTasks: 8 },
      ],
      isAgentAvailable: async () => true,
      isIssueCoolingDown: async () => false,
      isTaskBudgetBlocked: async () => false,
    } as unknown as SwarmMatcherDeps;

    // The reviewer belongs to project 0 while its engineer tasks remain
    // available, so null exercises the caste guard rather than an empty queue.
    const reviewerPass = await matchAgent(deps, reviewerId);
    expect(reviewerPass).toBeNull();
    const remainingForReviewer = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues).where(eq(issues.companyId, companyId));
    expect(remainingForReviewer).toHaveLength(100);
    expect(remainingForReviewer.every((row) => row.assigneeAgentId === null)).toBe(true);

    const passes: Array<Awaited<ReturnType<typeof matchAgent>>> = [];
    // Each matcher pass claims at most one task. Five seeded rounds exercise
    // all 20 agents repeatedly while keeping DB contention below pool capacity.
    for (let round = 0; round < 5; round += 1) {
      const roundOrder = scenario.rounds[round]!;
      for (let offset = 0; offset < roundOrder.length; offset += 4) {
        passes.push(...await Promise.all(
          roundOrder.slice(offset, offset + 4).map((agentId) => matchAgent(deps, agentId)),
        ));
      }
    }

    const assigned = await db.select({
      id: issues.id, projectId: issues.projectId, assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(eq(issues.companyId, companyId));
    const claimed = await db.select({
      issueId: issueClaims.issueId, agentId: issueClaims.agentId, role: issueClaims.role,
    }).from(issueClaims).where(eq(issueClaims.companyId, companyId));
    const agentProjects = new Map<string, Set<string>>();
    for (let p = 0; p < projectIds.length; p += 1) {
      for (const id of engineerIds.slice(p * 4, p * 4 + 4)) {
        const projectsForAgent = agentProjects.get(id) ?? new Set<string>();
        projectsForAgent.add(projectIds[p]!);
        agentProjects.set(id, projectsForAgent);
      }
    }

    for (const row of assigned) {
      expect(row.assigneeAgentId).not.toBeNull();
      expect(row.projectId).toBe(projectByTask.get(row.id));
      expect(agentProjects.get(row.assigneeAgentId!)?.has(row.projectId!)).toBe(true);
      expect(row.assigneeAgentId).not.toBe(reviewerId);
    }
    for (const claim of claimed) {
      expect(claim.role).toBe("engineer");
      expect(agentProjects.get(claim.agentId)?.has(projectByTask.get(claim.issueId)!)).toBe(true);
      expect(claim.agentId).not.toBe(reviewerId);
    }
    expect(assigned).toHaveLength(100);
    expect(claimed).toHaveLength(100);
    expect(passes.filter(Boolean)).toHaveLength(100);
  }, 120_000);
});
