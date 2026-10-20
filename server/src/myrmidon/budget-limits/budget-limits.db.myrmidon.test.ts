// server/src/myrmidon/budget-limits/budget-limits.db.myrmidon.test.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the two acceptance criteria of OPE-4161,
// on a live embedded-postgres database:
//  1. a caste limit is created, read, changed — and every change lands in
//     the journal (who, when, what);
//  2. "spent in period" of a level equals the sum of the level's task spend
//     (fixtures in litellm_cost_events, the existing accounting).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, litellmCostEvents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createBudgetLimitStore } from "./store.js";
import { computeBudgetLimitUsage } from "./usage.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("myrmidon(1.7-BUDGET-CONFIG A) limits and usage on a live database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-budget-limits-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(litellmCostEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    return db
      .insert(companies)
      .values({ name: `company ${randomUUID()}`, issuePrefix: `BL${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedAgent(companyId: string, role: string, name: string) {
    return db
      .insert(agents)
      .values({
        companyId,
        name,
        role,
        permissions: {},
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function costEvent(input: {
    companyId: string;
    agentId: string;
    issueId: string | null;
    costCents: number;
    occurredAt: Date;
  }) {
    return {
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      heartbeatRunId: null,
      provider: "openai",
      model: "gpt-x",
      inputTokens: 1,
      outputTokens: 1,
      costCents: input.costCents,
      occurredAt: input.occurredAt,
      requestId: randomUUID(),
    };
  }

  it("acceptance 1: a caste limit is created, read and changed, and each change is journaled", async () => {
    const company = await seedCompany();
    const store = createBudgetLimitStore({ db });
    const actor = { actorType: "user", actorId: "user-1" };

    // Create.
    const created = await store.upsert(company.id, "caste", "engineer", {
      amountCents: 10_000,
      period: "calendar_month_utc",
      mode: "hard",
      isActive: true,
    }, actor);
    expect(created.level).toBe("caste");
    expect(created.ref).toBe("engineer");
    expect(created.amountCents).toBe(10_000);
    expect(created.mode).toBe("hard");

    // Read.
    const read = await store.get(company.id, "caste", "engineer");
    expect(read).toMatchObject({ id: created.id, amountCents: 10_000, ref: "engineer" });

    // Change.
    const changed = await store.upsert(company.id, "caste", "engineer", {
      amountCents: 25_000,
      period: "calendar_month_utc",
      mode: "soft",
      isActive: true,
    }, actor);
    expect(changed.id).toBe(created.id);
    expect(changed.amountCents).toBe(25_000);
    expect(changed.mode).toBe("soft");

    // Journal: one create + one update, newest first, with before/after.
    const journal = await store.journal(company.id);
    expect(journal).toHaveLength(2);
    const updateEntry = journal[0]!;
    expect(updateEntry.action).toBe("update");
    expect(updateEntry.level).toBe("caste");
    expect(updateEntry.ref).toBe("engineer");
    expect(updateEntry.actorType).toBe("user");
    expect(updateEntry.actorId).toBe("user-1");
    expect(updateEntry.before).toMatchObject({ amountCents: 10_000, mode: "hard" });
    expect(updateEntry.after).toMatchObject({ amountCents: 25_000, mode: "soft" });
    expect(updateEntry.at).toBeTruthy();
    const createEntry = journal[1]!;
    expect(createEntry.action).toBe("create");
    expect(createEntry.before).toBeNull();
    expect(createEntry.after).toMatchObject({ amountCents: 10_000 });

    // Delete keeps the journal row.
    const removed = await store.remove(company.id, "caste", "engineer", actor);
    expect(removed).toBe(true);
    const journalAfterDelete = await store.journal(company.id);
    expect(journalAfterDelete).toHaveLength(3);
    expect(journalAfterDelete[0]!.action).toBe("delete");
    expect(journalAfterDelete[0]!.before).toMatchObject({ amountCents: 25_000 });
    expect(await store.get(company.id, "caste", "engineer")).toBeNull();
  });

  it("acceptance 2: caste-level spent equals the summed spend of the caste's agents (fixtures)", async () => {
    const company = await seedCompany();
    const otherCompany = await seedCompany();
    const engineerA = await seedAgent(company.id, "engineer", "eng-a");
    const engineerB = await seedAgent(company.id, "engineer", "eng-b");
    const designer = await seedAgent(company.id, "designer", "des-a");
    const otherEngineer = await seedAgent(otherCompany.id, "engineer", "eng-other");

    const now = new Date();
    const inPeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0));
    const outOfPeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15, 12, 0, 0));

    const issueX = await db
      .insert(issues)
      .values({ companyId: company.id, title: "x", status: "in_progress" })
      .returning()
      .then((rows) => rows[0]!);
    const issueY = await db
      .insert(issues)
      .values({ companyId: company.id, title: "y", status: "in_progress" })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(litellmCostEvents).values([
      costEvent({ companyId: company.id, agentId: engineerA.id, issueId: issueX.id, costCents: 120, occurredAt: inPeriod }),
      costEvent({ companyId: company.id, agentId: engineerB.id, issueId: issueY.id, costCents: 80, occurredAt: inPeriod }),
      // Same caste, but outside the calendar-month window — must not count.
      costEvent({ companyId: company.id, agentId: engineerA.id, issueId: issueX.id, costCents: 999, occurredAt: outOfPeriod }),
      // Same company, other caste — must not count for "engineer".
      costEvent({ companyId: company.id, agentId: designer.id, issueId: issueX.id, costCents: 500, occurredAt: inPeriod }),
      // Same caste, other company — must not count.
      costEvent({ companyId: otherCompany.id, agentId: otherEngineer.id, issueId: null, costCents: 700, occurredAt: inPeriod }),
    ]);

    const usage = await computeBudgetLimitUsage({ db }, company.id, "caste", "engineer", "calendar_month_utc");
    expect(usage.spentCents).toBe(200);
    expect(usage.events).toBe(2);
  });

  it("issue-level and company-nest spent match the ledger sums", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id, "engineer", "eng-a");
    const now = new Date();
    const inPeriod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0));

    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "t", status: "in_progress" })
      .returning()
      .then((rows) => rows[0]!);
    const unattributedIssue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "u", status: "in_progress" })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(litellmCostEvents).values([
      costEvent({ companyId: company.id, agentId: agent.id, issueId: issue.id, costCents: 30, occurredAt: inPeriod }),
      costEvent({ companyId: company.id, agentId: agent.id, issueId: issue.id, costCents: 70, occurredAt: inPeriod }),
      costEvent({ companyId: company.id, agentId: agent.id, issueId: unattributedIssue.id, costCents: 55, occurredAt: inPeriod }),
      costEvent({ companyId: company.id, agentId: agent.id, issueId: null, costCents: 5, occurredAt: inPeriod }),
    ]);

    const issueUsage = await computeBudgetLimitUsage({ db }, company.id, "issue", issue.id, "calendar_month_utc");
    expect(issueUsage.spentCents).toBe(100);
    expect(issueUsage.events).toBe(2);

    const nestUsage = await computeBudgetLimitUsage({ db }, company.id, "nest", "company", "calendar_month_utc");
    expect(nestUsage.spentCents).toBe(160);
    expect(nestUsage.events).toBe(4);

    // lifetime ignores the window: same sum here (all fixtures are this month).
    const lifetimeIssue = await computeBudgetLimitUsage({ db }, company.id, "issue", issue.id, "lifetime");
    expect(lifetimeIssue.spentCents).toBe(100);
  });

  it("one row per (company, level, ref): a second save replaces, a second company is separate", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const store = createBudgetLimitStore({ db });
    const actor = { actorType: "user", actorId: "user-1" };

    await store.upsert(companyA.id, "nest", "company", { amountCents: 1, period: "lifetime", mode: "hard", isActive: true }, actor);
    await store.upsert(companyA.id, "nest", "company", { amountCents: 2, period: "lifetime", mode: "soft", isActive: true }, actor);
    await store.upsert(companyB.id, "nest", "company", { amountCents: 3, period: "lifetime", mode: "hard", isActive: true }, actor);

    expect(await store.list(companyA.id)).toHaveLength(1);
    const limitA = await store.get(companyA.id, "nest", "company");
    const limitB = await store.get(companyB.id, "nest", "company");
    expect(limitA?.amountCents).toBe(2);
    expect(limitB?.amountCents).toBe(3);
  });
});
