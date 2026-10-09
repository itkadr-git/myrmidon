// server/src/myrmidon/scent.db.myrmidon.test.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): the scent paths that only mean something on a
// real database — the real issueService.create hook, the markup-queue SELECT,
// the hourly ledger and the write-back of the auto caste/strength. Embedded
// Postgres, mocked gateway (no network).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issues, projects } from "@paperclipai/db";
import { DEFAULT_SCENT_SETTINGS, defaultStrengthForPriority, type IssueScent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { canSpendCall, createScentService } from "./scent/service.js";
import type { ScentGateway } from "./scent/gateway.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const CASTES = ["engineer", "designer", "marketer"];

const CSS_SCENT: IssueScent = {
  tags: ["css", "button"],
  casteProbs: { engineer: 0.8, designer: 0.1 },
  complexity: { coordination: 0.1, uncertainty: 0.1, consequences: 0.05 },
};
const SERIOUS_SCENT: IssueScent = {
  tags: ["payments"],
  casteProbs: { engineer: 0.9 },
  complexity: { coordination: 0.4, uncertainty: 0.3, consequences: 0.7 },
};

describeEmbeddedPostgres("myrmidon(1.6.5 F-26 T10 SCENT) on a real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-scent-t10-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `company ${id}`,
      issuePrefix: `S${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    companyId = id;
    return id;
  }

  async function makeIssue(
    patch: Partial<typeof issues.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(issues)
      .values({
        companyId,
        title: `task ${randomUUID().slice(0, 6)}`,
        description: "Описание задачи.",
        status: "todo",
        priority: "medium",
        ...patch,
      })
      .returning();
    return row!.id;
  }

  async function readIssue(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }

  function serviceWith(gateway: ScentGateway) {
    return createScentService({
      db,
      companyId,
      settings: DEFAULT_SCENT_SETTINGS,
      gateway,
      casteKeys: CASTES,
      logActivity: async (entry) => {
        await db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "system",
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          details: entry.details ?? {},
        });
      },
    });
  }

  const gatewayReturning = (scent: IssueScent | null): ScentGateway & { calls: number } => {
    const g = {
      calls: 0,
      classifyIssueScent: async () => {
        g.calls += 1;
        if (!scent) throw new Error("gateway refused");
        return { scent, model: "m", inputTokens: 10, outputTokens: 5 };
      },
      classifyAgentScent: async () => {
        g.calls += 1;
        return { tags: ["triage"], model: "m", inputTokens: 1, outputTokens: 1 };
      },
    };
    return g;
  };

  // --- the real create hook (issueService.create) -----------------------------

  it("issueService.create: an explicit caste is stamped 'manual'; no caste and no scent leaves NULL/NULL", async () => {
    await makeCompany();
    const svc = issueService(db);
    const explicit = await svc.create(companyId, {
      title: "Поправить CSS кнопки",
      description: "Кнопка наезжает на поле.",
      status: "todo",
      priority: "medium",
      casteKey: "designer",
    });
    const row1 = await readIssue(explicit.id);
    expect(row1.casteKey).toBe("designer");
    expect(row1.casteSource).toBe("manual");

    // «Test» without a description: no scent, no caste, and the company default
    // caste is NOT materialized as 'auto' (design §2.1 chain applies at read time).
    const bare = await svc.create(companyId, {
      title: "Test",
      description: null,
      status: "todo",
      priority: "medium",
    });
    const row2 = await readIssue(bare.id);
    expect(row2.casteKey).toBeNull();
    expect(row2.casteSource).toBeNull();
    expect(row2.scent).toBeNull();
  });

  it("issueService.create: a forged casteSource is not trusted", async () => {
    await makeCompany();
    const svc = issueService(db);
    const created = await svc.create(companyId, {
      title: "Задача",
      description: "Описание.",
      status: "todo",
      priority: "medium",
      casteKey: "marketer",
      casteSource: "auto",
    } as never);
    expect((await readIssue(created.id)).casteSource).toBe("manual");
  });

  // --- the markup queue SELECT ---------------------------------------------

  it("listMarkupQueue: open todo only, scent-less only, agents with capabilities only", async () => {
    await makeCompany();
    const todo = await makeIssue({ status: "todo" });
    await makeIssue({ status: "done" });
    await makeIssue({ status: "cancelled" });
    await makeIssue({ status: "in_progress" });
    await makeIssue({ status: "todo", scent: CSS_SCENT });
    const old = await makeIssue({ status: "todo" });
    await db.execute(
      sql`update issues set created_at = now() - interval '90 days' where id = ${old}`,
    );
    const [withCaps] = await db
      .insert(agents)
      .values({ companyId, name: "a1", role: "engineer", capabilities: "Frontend CSS and tests" })
      .returning();
    await db.insert(agents).values({ companyId, name: "a2", role: "engineer", capabilities: "  " });
    await db.insert(agents).values({ companyId, name: "a3", role: "engineer" });
    await db.insert(agents).values({
      companyId,
      name: "a4",
      role: "engineer",
      capabilities: "Already tagged",
      scentTags: ["sql"],
    });

    const slice = await serviceWith(gatewayReturning(CSS_SCENT)).listMarkupQueue(20);
    expect(slice.issueIds).toEqual([todo]);
    expect(slice.agentIds).toEqual([withCaps!.id]);
  });

  // --- the hourly ledger counts failures ---------------------------------------

  it("a refused gateway call spends the hour budget: the same record is not re-picked", async () => {
    await makeCompany();
    const id = await makeIssue();
    const gateway = gatewayReturning(null); // always refuses
    const service = serviceWith(gateway);

    const first = await service.classifyIssue(id);
    expect(first).toMatchObject({ classified: false, spent: true });
    expect(gateway.calls).toBe(1);
    await expect(
      canSpendCall(db, { entityType: "issue", entityId: id, maxPerHour: 1 }),
    ).resolves.toBe(false);

    const second = await service.classifyIssue(id);
    expect(second).toMatchObject({ classified: false, spent: false });
    expect(gateway.calls).toBe(1);
  });

  // --- the write-back: auto caste and strength ---------------------------------

  it("classifyIssue sets the auto caste on a task without one", async () => {
    await makeCompany();
    const id = await makeIssue({ pheromoneStrength: defaultStrengthForPriority("medium") });
    await serviceWith(gatewayReturning(CSS_SCENT)).classifyIssue(id);
    const row = await readIssue(id);
    expect(row.scent).toMatchObject({ tags: ["css", "button"] });
    expect(row.casteKey).toBe("engineer");
    expect(row.casteSource).toBe("auto");
    // no bonus on a plain task: the strength is untouched
    expect(row.pheromoneStrength).toBe(defaultStrengthForPriority("medium"));
  });

  it("classifyIssue never overwrites an explicit caste or an explicit strength", async () => {
    await makeCompany();
    const id = await makeIssue({ casteKey: "designer", casteSource: "manual", pheromoneStrength: 3 });
    await serviceWith(gatewayReturning(SERIOUS_SCENT)).classifyIssue(id);
    const row = await readIssue(id);
    expect(row.scent).not.toBeNull();
    expect(row.casteKey).toBe("designer");
    expect(row.casteSource).toBe("manual");
    expect(row.pheromoneStrength).toBe(3);
  });

  it("a serious task (consequences 0.7) gets the consequences bonus on top of the priority base", async () => {
    await makeCompany();
    const base = defaultStrengthForPriority("medium");
    const id = await makeIssue({ pheromoneStrength: base });
    await serviceWith(gatewayReturning(SERIOUS_SCENT)).classifyIssue(id);
    const row = await readIssue(id);
    expect(row.pheromoneStrength).toBe(base + DEFAULT_SCENT_SETTINGS.consequencesBonus);
  });

  it("a refresh may change the earlier 'auto' pick but not a manual one", async () => {
    await makeCompany();
    const id = await makeIssue({ casteKey: "marketer", casteSource: "auto" });
    await serviceWith(gatewayReturning(CSS_SCENT)).classifyIssue(id);
    expect((await readIssue(id)).casteKey).toBe("engineer");
  });
});
