// server/src/myrmidon/budget-limits/admission.db.myrmidon.test.ts
//
// myrmidon(1.7-BUDGET-CONFIG): the hierarchy limits of A act on run
// admission through the real budget service, against a live embedded
// postgres. The epic acceptance — "a limit change acts in the queue within
// a minute, no restart" — has two halves pinned here:
//  1. the wiring: `getInvocationBlock` consults the A-hierarchy hook and
//     refuses when the effective hard limit is over its period (deeper
//     level wins: a task limit over a caste limit over the nest);
//  2. the freshness: the limit is raised through the normal store write and
//     the very next admission passes — no cache, no restart;
//  3. the safety: signal-only (the default state of the flag) never
//     refuses, and an absent hook keeps the vendor behaviour (null).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, litellmCostEvents } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { budgetService } from "../../services/budgets.js";
import { createBudgetLimitStore } from "./store.js";
import { evaluateBudgetLimitAdmission } from "./admission.js";
import { readResolvedSignalOnly } from "./settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budget-limit admission against the real service (1.7 BUDGET-CONFIG)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-limits-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(litellmCostEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `BA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      casteKey: "engineer",
    });
    return { companyId, agentId, issueId };
  }

  async function spend(companyId: string, agentId: string, issueId: string, cents: number) {
    await db.insert(litellmCostEvents).values({
      id: randomUUID(),
      companyId,
      agentId,
      issueId,
      heartbeatRunId: null,
      provider: "test",
      model: "test-model",
      inputTokens: 1,
      outputTokens: 1,
      costCents: cents,
      occurredAt: new Date(),
      requestId: randomUUID(),
    });
  }

  /** The exact wiring heartbeat.ts installs (stored signal-only forced off for the enforcement cases). */
  function serviceWithLimits(companyId: string, env: NodeJS.ProcessEnv = {}) {
    return budgetService(db, {
      resolveBudgetLimitAdmissionBlock: async ({ agentId, context }) =>
        evaluateBudgetLimitAdmission({ db, env }, {
          companyId,
          agentId,
          issueId: context?.issueId ?? null,
          projectId: context?.projectId ?? null,
          settings: signalOnlyOffSettings(),
        }),
    });
  }

  function signalOnlyOffSettings() {
    // The stored flag is OFF (enforce): the default state is ON, so the
    // enforcement leg of every test below is observable.
    return {
      getGeneral: async () => ({ budgetLimits: { signalOnly: false } }),
      updateGeneral: async () => ({}),
    } as unknown as Parameters<typeof readResolvedSignalOnly>[0];
  }

  function eqId(id: string) {
    // Small local helper: `eq(agents.id, id)` without pulling drizzle into
    // the test header (the production evaluator does the join properly).
    return sqlEq("agents", "id", id);
  }

  it("a hard caste limit over its month refuses the next admission — deeper task limit wins first", async () => {
    const { companyId, agentId, issueId } = await seed();
    const store = createBudgetLimitStore({ db });
    const actor = { actorType: "user" as const, actorId: "user-1" };

    // A caste limit at $5 (hard) and a task limit at $2 (hard): the task
    // level is deeper, so IT decides — its period spend is the task's.
    await store.upsert(companyId, "caste", "engineer", { amountCents: 500, period: "calendar_month_utc", mode: "hard", isActive: true }, actor);
    await store.upsert(companyId, "issue", issueId, { amountCents: 200, period: "calendar_month_utc", mode: "hard", isActive: true }, actor);
    await spend(companyId, agentId, issueId, 300);

    const block = await serviceWithLimits(companyId).getInvocationBlock(companyId, agentId, { issueId });
    expect(block).not.toBeNull();
    expect(block!.reason).toContain("$3.00"); // the task-level spend
    expect(block!.reason).toContain("$2.00"); // the task-level limit
    expect(block!.scopeType).toBe("agent"); // issue-level refusal reported on the agent scope
    expect(block!.scopeId).toBe(agentId);
  });

  it("raising the limit lets the very next admission through — no restart, no cache", async () => {
    const { companyId, agentId, issueId } = await seed();
    const store = createBudgetLimitStore({ db });
    const actor = { actorType: "user" as const, actorId: "user-1" };
    await store.upsert(companyId, "caste", "engineer", { amountCents: 500, period: "calendar_month_utc", mode: "hard", isActive: true }, actor);
    await spend(companyId, agentId, issueId, 600);

    const service = serviceWithLimits(companyId);
    const blocked = await service.getInvocationBlock(companyId, agentId, { issueId });
    expect(blocked).not.toBeNull();

    // The owner raises the caste limit through the normal write path…
    await store.upsert(companyId, "caste", "engineer", { amountCents: 5_000, period: "calendar_month_utc", mode: "hard", isActive: true }, actor);
    // …and the next admission of the same minute passes.
    expect(await service.getInvocationBlock(companyId, agentId, { issueId })).toBeNull();
  });

  it("signal-only (the default) never refuses; switching to enforce changes the next admission", async () => {
    const { companyId, agentId, issueId } = await seed();
    const store = createBudgetLimitStore({ db });
    const actor = { actorType: "user" as const, actorId: "user-1" };
    await store.upsert(companyId, "caste", "engineer", { amountCents: 500, period: "calendar_month_utc", mode: "hard", isActive: true }, actor);
    await spend(companyId, agentId, issueId, 600);

    // The default settings state (no stored key) resolves signal-only ON.
    const defaultSettings = {
      getGeneral: async () => ({}),
      updateGeneral: async () => ({}),
    } as unknown as Parameters<typeof readResolvedSignalOnly>[0];
    const block = await evaluateBudgetLimitAdmission({ db }, {
      companyId,
      agentId,
      issueId,
      projectId: null,
      settings: defaultSettings,
    });
    expect(block).toBeNull();

    // Enforce (the stored flag off) — the same overrun now refuses.
    const enforceBlock = await evaluateBudgetLimitAdmission({ db }, {
      companyId,
      agentId,
      issueId,
      projectId: null,
      settings: signalOnlyOffSettings(),
    });
    expect(enforceBlock).not.toBeNull();
    expect(enforceBlock!.reason).toContain("$6.00");
    expect(enforceBlock!.sourceLevel).toBe("caste");
  });

  it("an absent hook keeps the vendor behaviour: no hierarchy limits, no block", async () => {
    const { companyId, agentId, issueId } = await seed();
    const store = createBudgetLimitStore({ db });
    const actor = { actorType: "user" as const, actorId: "user-1" };
    await store.upsert(companyId, "caste", "engineer", { amountCents: 100, period: "calendar_month_utc", mode: "hard", isActive: true }, actor);
    await spend(companyId, agentId, issueId, 600);

    const service = budgetService(db, {}); // vendor semantics
    expect(await service.getInvocationBlock(companyId, agentId, { issueId })).toBeNull();
  });
});
