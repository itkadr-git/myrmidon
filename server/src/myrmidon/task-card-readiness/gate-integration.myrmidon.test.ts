import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  labels,
  issueLabels,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { issueService } from "../../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping task card readiness gate integration tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const VALID_CARD_DESCRIPTION = `
МЕСТО ПРАВКИ: server/src/routes/issues.ts
НАМЕРЕНИЕ: Проверить полноту карточки перед передачей инженеру.
ГРАНИЦА ОБЪЁМА: Только задачи инженера при переходе или создании в todo.
КРИТЕРИИ ПРИЁМКИ:
- Утверждение: Ложно, если неполная карточка уходит в todo.
ТЕСТ: gate-integration.myrmidon.test.ts
`;

const INCOMPLETE_CARD_DESCRIPTION = `
Короткое описание без требуемых секций.
`;

describeEmbeddedPostgres("task card readiness gate integration (TASK-CARD-READINESS-3)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalGateMode = process.env.MYRMIDON_TASK_CARD_GATE_MODE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-card-gate-test-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    process.env.MYRMIDON_TASK_CARD_GATE_MODE = "enforce";
  }, 20_000);

  afterAll(async () => {
    if (originalGateMode !== undefined) {
      process.env.MYRMIDON_TASK_CARD_GATE_MODE = originalGateMode;
    } else {
      delete process.env.MYRMIDON_TASK_CARD_GATE_MODE;
    }
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GateTestCompany",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("POST /api/companies/:companyId/issues: creating engineer issue directly in todo with incomplete card is rejected with 422", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Engineer task",
        description: INCOMPLETE_CARD_DESCRIPTION,
        status: "todo",
        casteKey: "engineer",
      })
      .expect(422);

    expect(res.body.code).toBe("task_card_not_ready");
    expect(Array.isArray(res.body.violations)).toBe(true);
    expect(res.body.violations.length).toBeGreaterThan(0);

    const created = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(created).toHaveLength(0);
  });

  it("POST /api/companies/:companyId/issues: creating engineer issue directly in todo with valid card succeeds (201)", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Engineer task with complete card",
        description: VALID_CARD_DESCRIPTION,
        status: "todo",
        casteKey: "engineer",
      })
      .expect(201);

    expect(res.body.status).toBe("todo");
    expect(res.body.casteKey).toBe("engineer");
  });

  it("POST /api/companies/:companyId/issues: creating non-engineer issue directly in todo is not gated", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Lead task",
        description: INCOMPLETE_CARD_DESCRIPTION,
        status: "todo",
        casteKey: "lead",
      })
      .expect(201);

    expect(res.body.status).toBe("todo");
  });

  it("PATCH /api/issues/:id: moving engineer issue to todo with incomplete card is rejected with 422 and status remains unchanged", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Engineer backlog task",
        description: INCOMPLETE_CARD_DESCRIPTION,
        status: "backlog",
        casteKey: "engineer",
        priority: "medium",
      })
      .returning();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "todo" })
      .expect(422);

    expect(res.body.code).toBe("task_card_not_ready");
    expect(Array.isArray(res.body.violations)).toBe(true);

    const [persisted] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(persisted.status).toBe("backlog");
  });

  it("PATCH /api/issues/:id: moving engineer issue to todo with valid card succeeds", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Engineer backlog task",
        description: VALID_CARD_DESCRIPTION,
        status: "backlog",
        casteKey: "engineer",
        priority: "medium",
      })
      .returning();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "todo" })
      .expect(200);

    expect(res.body.status).toBe("todo");
  });

  it("PATCH /api/issues/:id: moving non-engineer issue to todo is not gated", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "PM backlog task",
        description: INCOMPLETE_CARD_DESCRIPTION,
        status: "backlog",
        casteKey: "pm",
        priority: "medium",
      })
      .returning();

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "todo" })
      .expect(200);

    expect(res.body.status).toBe("todo");
  });

  it("service updateIssue without taskCardGate flag does not block transitions (e.g. auto-unblock / internal transitions)", async () => {
    const companyId = await seedCompany();

    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Blocked engineer task",
        description: INCOMPLETE_CARD_DESCRIPTION,
        status: "blocked",
        casteKey: "engineer",
        priority: "medium",
      })
      .returning();

    const updated = await svc.update(issue.id, {
      status: "todo",
    });

    expect(updated?.status).toBe("todo");
  });
});
