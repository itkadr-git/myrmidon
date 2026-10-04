// myrmidon(1.7-BUDGET-CONFIG-B): budget enforcement modes — what a crossed
// limit does while the incident is open.
//
// The three acceptance criteria of the ticket, pinned against the real
// service on an embedded database:
//  - signal_only (the default): the incident is created, the owner signal is
//    delivered into the issue thread, and the scope is NOT paused — runs
//    start, `getInvocationBlock` answers null.
//  - soft: the scope is paused and the interrupted thread gets the M3
//    hard-stop signal; the blocked-scope arms of `getInvocationBlock` refuse;
//    raising the budget through the incident-resolution path resumes the
//    scope (the "expand" leg of the card).
//  - hard: the over-limit-but-not-paused arm of `getInvocationBlock` refuses
//    with the budget reason.
//
// Plus the mode resolver precedence (settings over env over default) and the
// settings-page survival of the stored key.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  DEFAULT_BUDGET_ENFORCEMENT_MODE,
  parseBudgetEnforcementMode,
  resolveBudgetEnforcement,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { budgetService } from "../services/budgets.js";
import {
  deliverBudgetSignalOnly,
  buildBudgetSignalOnlyBody,
  type BudgetSignalOnlyPorts,
} from "../myrmidon/budget-enforcement/signal.js";
import { budgetEnforcementService } from "../myrmidon/budget-enforcement/service.js";
import { preserveBudgetEnforcementGeneralKey } from "../myrmidon/budget-enforcement/settings.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("budget enforcement mode resolution (BUDGET-CONFIG B)", () => {
  it("defaults to signal_only until the owner switches it off", () => {
    expect(DEFAULT_BUDGET_ENFORCEMENT_MODE).toBe("signal_only");
    expect(resolveBudgetEnforcement({})).toEqual({ mode: "signal_only", source: "default" });
  });

  it("the stored settings value wins over the environment", () => {
    expect(
      resolveBudgetEnforcement({ stored: { mode: "soft" }, env: { MYRMIDON_BUDGET_ENFORCEMENT_MODE: "hard" } }),
    ).toEqual({ mode: "soft", source: "settings" });
  });

  it("the environment is the forced override while nothing is stored", () => {
    expect(
      resolveBudgetEnforcement({ env: { MYRMIDON_BUDGET_ENFORCEMENT_MODE: "hard" } }),
    ).toEqual({ mode: "hard", source: "env" });
  });

  it("an unreadable stored row or env value falls through, never wedges", () => {
    expect(resolveBudgetEnforcement({ stored: { mode: "banana" } })).toEqual({ mode: "signal_only", source: "default" });
    expect(resolveBudgetEnforcement({ env: { MYRMIDON_BUDGET_ENFORCEMENT_MODE: "yes" } })).toEqual({
      mode: "signal_only",
      source: "default",
    });
    expect(parseBudgetEnforcementMode(" HARD ")).toBe("hard");
    expect(parseBudgetEnforcementMode("off")).toBe(null);
  });

  it("the stored key survives a vendor general write", () => {
    expect(preserveBudgetEnforcementGeneralKey({ budgetEnforcement: { mode: "soft" } })).toEqual({
      budgetEnforcement: { mode: "soft" },
    });
    expect(preserveBudgetEnforcementGeneralKey({})).toEqual({});
    expect(preserveBudgetEnforcementGeneralKey(null)).toEqual({});
  });
});

describeEmbeddedPostgres("budget enforcement modes against the real service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-enforcement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
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
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
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
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    return { companyId, agentId, issueId };
  }

  async function insertCostEvent(companyId: string, agentId: string, costCents: number) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        provider: "test",
        biller: "test",
        billingType: "metered_api",
        model: "test-model",
        inputTokens: 10,
        outputTokens: 5,
        costCents,
        occurredAt: new Date(),
      })
      .returning();
    return event!;
  }

  /** The signal-only delivery port writing through the real comment table. */
  function signalOnlyPorts(companyId: string): BudgetSignalOnlyPorts {
    return {
      addComment: async (issueId, body, _actor, options) => {
        await db.insert(issueComments).values({
          companyId,
          issueId,
          authorType: "system",
          body,
          presentation: options.presentation,
          metadata: options.metadata,
        });
        return null;
      },
      log: { info: () => {}, warn: () => {} },
    };
  }

  async function agentRow(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row!;
  }

  async function systemComments(issueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  it("signal_only: the limit crosses, the signal is delivered, and the scope keeps running", async () => {
    const { companyId, agentId, issueId } = await seed();
    const service = budgetService(db, {
      resolveEnforcementMode: async () => "signal_only",
      signalBudgetLimitCrossed: async (input) => {
        await deliverBudgetSignalOnly(db, signalOnlyPorts(companyId), input);
      },
    });

    const event = await insertCostEvent(companyId, agentId, 120);
    await service.evaluateCostEvent(event);

    // The incident exists...
    const incidents = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId));
    expect(incidents.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);

    // ...the scope was NOT paused and no run was cancelled...
    expect((await agentRow(agentId)).status).toBe("active");
    expect((await agentRow(agentId)).pauseReason).toBeNull();

    // ...and the owner signal is in the issue thread.
    const comments = await systemComments(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("limit was crossed");
    expect(comments[0]?.body).toContain("Nothing stopped");
    expect(comments[0]?.body).toContain("$1.00");
    expect(comments[0]?.body).toContain("$1.20");
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "warning" });

    // The repeat evaluation does not duplicate the signal (incident dedup).
    await service.evaluateCostEvent(event);
    expect(await systemComments(issueId)).toHaveLength(1);

    // And the run admission gate lets a run start: no invocation block.
    expect(await service.getInvocationBlock(companyId, agentId, { issueId })).toBeNull();
  });

  it("soft: the scope is paused, the interrupted thread is signalled, and raising the budget resumes", async () => {
    const { companyId, agentId, issueId } = await seed();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, {
      resolveEnforcementMode: async () => "soft",
      cancelWorkForScope,
    });

    const event = await insertCostEvent(companyId, agentId, 120);
    await service.evaluateCostEvent(event);

    // Pause + cancel: the soft stop.
    expect((await agentRow(agentId)).status).toBe("paused");
    expect((await agentRow(agentId)).pauseReason).toBe("budget");
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
    });

    // A run of the paused scope is refused (the pause is the stop).
    const block = await service.getInvocationBlock(companyId, agentId, { issueId });
    expect(block).toMatchObject({ scopeType: "agent", scopeId: agentId });
    expect(block?.reason).toContain("paused because its budget hard-stop");

    // "Expand": the owner raises the budget through the incident-resolution
    // path (the action behind the card's Raise button)...
    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    await service.resolveIncident(companyId, incident!.id, {
      action: "raise_budget_and_resume",
      amount: 500,
    });

    // ...and the pause lifts: the agent is invokable again.
    expect((await agentRow(agentId)).status).toBe("idle");
    expect((await agentRow(agentId)).pauseReason).toBeNull();
    expect(await service.getInvocationBlock(companyId, agentId, { issueId })).toBeNull();
  });

  it("hard: an over-limit scope that was never paused still refuses a run with the budget reason", async () => {
    const { companyId, agentId, issueId } = await seed();
    // Hard mode, but the pause did not happen (the scope was skipped by the
    // pause update — e.g. it was already paused for another reason and has
    // since resumed); the policy-amount arm must still refuse.
    const service = budgetService(db, {
      resolveEnforcementMode: async () => "hard",
      cancelWorkForScope: vi.fn().mockResolvedValue(undefined),
    });

    await insertCostEvent(companyId, agentId, 120);

    const block = await service.getInvocationBlock(companyId, agentId, { issueId });
    expect(block).toMatchObject({ scopeType: "agent", scopeId: agentId });
    expect(block?.reason).toContain("budget hard-stop");
  });

  it("no mode hook keeps the vendor semantics: the stop always enforces", async () => {
    const { companyId, agentId } = await seed();
    const service = budgetService(db, {});
    const event = await insertCostEvent(companyId, agentId, 120);
    await service.evaluateCostEvent(event);
    expect((await agentRow(agentId)).status).toBe("paused");
    expect((await agentRow(agentId)).pauseReason).toBe("budget");
  });
});

describeEmbeddedPostgres("budget enforcement settings service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-enforcement-svc-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
    mockLogActivity.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("writes the mode to the settings row, audits it for every company, and reports the source", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-b",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const service = budgetEnforcementService(db, { env: {} });
    expect(await service.read()).toEqual({ mode: "signal_only", source: "default" });

    const view = await service.update({ mode: "hard" }, {
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
    });
    expect(view).toEqual({ mode: "hard", source: "settings" });
    expect(await service.read()).toEqual({ mode: "hard", source: "settings" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "instance.budget_enforcement.updated",
        details: { mode: "hard" },
      }),
    );
  });
});

describe("budget signal-only text (BUDGET-CONFIG B)", () => {
  it("names the crossed limit and says nothing stopped", () => {
    const body = buildBudgetSignalOnlyBody({
      companyId: "c",
      incidentId: "i",
      scopeType: "agent",
      scopeId: "a",
      scopeName: "agent-a",
      amountLimit: 1000,
      amountObserved: 1200,
    });
    expect(body).toContain("limit was crossed");
    expect(body).toContain('agent "agent-a"');
    expect(body).toContain("$10.00");
    expect(body).toContain("$12.00");
    expect(body).toContain("signal-only mode");
    expect(body).not.toContain("paused");
  });
});
