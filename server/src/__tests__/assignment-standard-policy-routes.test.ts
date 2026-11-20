import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, projects } from "@myrmidon/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent assignment with standard-only policy", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const previousSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;

  beforeAll(async () => {
    process.env.MYRMIDON_AGENT_JWT_SECRET = "assignment-policy-route-test-secret";
    database = await startEmbeddedPostgresTestDatabase("assignment-policy-routes-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (previousSecret === undefined) delete process.env.MYRMIDON_AGENT_JWT_SECRET;
    else process.env.MYRMIDON_AGENT_JWT_SECRET = previousSecret;
  });

  it("creates a read-only scope child through the authenticated agent route, while unknown policy remains denied", async () => {
    const [company] = await db.insert(companies).values({ name: "Assignment", issuePrefix: `AS${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "Read-only PBS WAL" }).returning();
    const [actor, target] = await db.insert(agents).values([
      { companyId: company!.id, name: "Actor", role: "engineer", adapterType: "process", permissions: {} },
      { companyId: company!.id, name: "Target", role: "engineer", adapterType: "process", permissions: { authorizationPolicy: { trustPreset: "standard" } } },
    ]).returning();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company!.id, agentId: actor!.id, status: "running" });
    const [parent] = await db.insert(issues).values({ companyId: company!.id, projectId: project!.id, title: "PBS WAL", status: "in_progress", assigneeAgentId: actor!.id, executionRunId: runId }).returning();
    const token = createLocalAgentJwt(actor!.id, company!.id, "process", runId);
    expect(token).toBeTruthy();
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
    app.use(errorHandler);
    const create = (title: string) => request(app).post(`/api/companies/${company!.id}/issues`)
      .set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", runId)
      .send({ title, description: "Read-only PBS/WAL investigation; no production changes.", parentId: parent!.id, projectId: project!.id, assigneeAgentId: target!.id });

    const allowed = await create("Read-only investigation");
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body).toMatchObject({ parentId: parent!.id, projectId: project!.id, assigneeAgentId: target!.id });

    await db.update(agents).set({ permissions: { authorizationPolicy: { trustPreset: "standard", unknownExtension: true } } }).where(eq(agents.id, target!.id));
    const denied = await create("Unknown policy investigation");
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain("deny_policy_restricted");
  });
});
