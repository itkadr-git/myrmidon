import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, approvals, companies, createDb, type Db } from "@myrmidon/db";
import { admScopeHash, createAdmCapabilityToken } from "@myrmidon/shared/adm-access-request-server";
import { eq, inArray } from "drizzle-orm";
import { errorHandler } from "../middleware/index.js";
import { admAccessRequestRoutes } from "../routes/adm-access-requests.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Company = { id: string; agentId: string };

async function makeCompany(db: Db, name: string): Promise<Company> {
  const [company] = await db.insert(companies).values({
    name: `${name}-${randomUUID()}`,
    issuePrefix: `AC${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    companyId: company!.id, name: `${name} agent`, role: "engineer", title: "engineer",
    urlKey: `${name.toLowerCase()}-${randomUUID()}`, status: "idle", adapterType: "process",
    adapterConfig: {}, runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0,
    permissions: { canCreateAgents: false },
  }).returning();
  return { id: company!.id, agentId: agent!.id };
}

function appFor(db: Db, company: Company, board = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = board
      ? { type: "board", userId: `user-${company.id}`, companyIds: [company.id], source: "session", isInstanceAdmin: false }
      : { type: "agent", agentId: company.agentId, companyId: company.id, source: "agent_key", isInstanceAdmin: false };
    next();
  });
  app.use("/api", admAccessRequestRoutes(db, { capabilityExecutor: {
    async execute(input) {
      return { executed: true, result: { kind: "test_executor", resourceKey: input.resourceKey } };
    },
  } }));
  app.use(errorHandler);
  return app;
}

describePostgres("company boundaries ADM channel contract", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sources: Company[];
  let adm: Company;
  let previousSecret: string | undefined;
  let previousAdm: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-adm-contract-");
    db = createDb(tempDb.connectionString);
    sources = await Promise.all(["BBQ", "Work", "Life"].map((name) => makeCompany(db, name)));
    adm = await makeCompany(db, "ADM");
    previousSecret = process.env.AGENT_JWT_SECRET;
    previousAdm = process.env.ADM_COMPANY_ID;
    process.env.AGENT_JWT_SECRET = "contract-test-signing-material-not-production";
    process.env.ADM_COMPANY_ID = adm.id;
  }, 60_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.AGENT_JWT_SECRET;
    else process.env.AGENT_JWT_SECRET = previousSecret;
    if (previousAdm === undefined) delete process.env.ADM_COMPANY_ID;
    else process.env.ADM_COMPANY_ID = previousAdm;
    if (db && sources && adm) {
      const ids = [...sources, adm].map((company) => company.id);
      await db.delete(activityLog).where(inArray(activityLog.companyId, ids));
      await db.delete(approvals).where(inArray(approvals.companyId, ids));
      await db.delete(agents).where(inArray(agents.companyId, ids));
      await db.delete(companies).where(inArray(companies.id, ids));
    }
    await tempDb?.cleanup();
  });

  function body(action: "grant_capability" | "invoke_tool") {
    const tool = action === "invoke_tool";
    return {
      targetCompanyId: adm.id, resourceType: tool ? "tool" : "skill",
      resourceRef: tool ? "tool:contract-tool" : "skill:contract-skill", action,
      justification: "Scoped access for contract verification",
      requestedScope: { resourceKey: tool ? "contract-tool" : "contract-skill" },
      ttlSeconds: 60, idempotencyKey: randomUUID(),
    };
  }

  it("requires ADM approval and audits scoped rights and tool requests for each company", async () => {
    for (const source of sources) for (const action of ["grant_capability", "invoke_tool"] as const) {
      const input = body(action);
      const sourceApp = appFor(db, source);
      const created = await request(sourceApp).post(`/api/companies/${source.id}/adm/access-requests`).send(input);
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("pending");
      const id = created.body.requestId as string;
      const issued = createAdmCapabilityToken({
        requestId: id, sourceCompanyId: source.id, targetCompanyId: adm.id,
        requesterType: "agent", requesterId: source.agentId, resourceType: input.resourceType,
        resourceRef: input.resourceRef, action, scopeHash: admScopeHash(input.requestedScope), ttlSeconds: 60,
      });
      expect(issued).not.toBeNull();
      const pending = await request(sourceApp).post(`/api/companies/${source.id}/adm/capability/execute`).send({ capabilityToken: issued!.token });
      expect(pending.status).toBe(403);
      const decided = await request(appFor(db, adm, true)).post(`/api/adm/access-requests/${id}/decide`).send({ decision: "approved" });
      expect(decided.status).toBe(200);
      const executed = await request(sourceApp).post(`/api/companies/${source.id}/adm/capability/execute`).send({ capabilityToken: decided.body.capabilityToken });
      expect(executed.status).toBe(200);
      expect(executed.body.executed).toBe(true);
      expect(executed.body.result.kind).toBe(action === "invoke_tool" ? "test_executor" : "scoped_grant_confirmation");
      const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, id));
      expect(audit.some((row) => row.companyId === source.id && row.action === "adm_access_request.created")).toBe(true);
      expect(audit.some((row) => row.companyId === adm.id && row.action === "adm_access_request.received")).toBe(true);
      expect(audit.some((row) => row.companyId === adm.id && row.action === "adm_access_request.decided")).toBe(true);
      expect(audit.some((row) => row.companyId === adm.id && row.action === "adm_access_request.executed")).toBe(true);
    }
  });

  it("rejects requests outside rights and tools", async () => {
    const source = sources[0]!;
    for (const resourceType of ["task", "project", "budget", "memory", "secret"]) {
      const input = { ...body("grant_capability"), resourceType, resourceRef: `${resourceType}:outside`, action: "read_metadata", requestedScope: { resourceKey: "outside" } };
      const result = await request(appFor(db, source)).post(`/api/companies/${source.id}/adm/access-requests`).send(input);
      expect(result.status, resourceType).toBeGreaterThanOrEqual(400);
    }
  });

  it("denies revoked and expired capabilities without disclosing data to another company", async () => {
    const source = sources[0]!;
    for (const mode of ["revoked", "expired"] as const) {
      const sourceApp = appFor(db, source);
      const created = await request(sourceApp).post(`/api/companies/${source.id}/adm/access-requests`).send(body("invoke_tool"));
      expect(created.status).toBe(201);
      const id = created.body.requestId as string;
      const decided = await request(appFor(db, adm, true)).post(`/api/adm/access-requests/${id}/decide`).send({ decision: "approved" });
      expect(decided.status).toBe(200);
      const capabilityToken = decided.body.capabilityToken as string;
      if (mode === "revoked") {
        const revoked = await request(sourceApp).post(`/api/companies/${source.id}/adm/access-requests/${id}/revoke`).send({ reason: "finished" });
        expect(revoked.status).toBe(200);
      } else {
        const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
        await db.update(approvals).set({ payload: { ...row!.payload, expiresAt: new Date(0).toISOString() } }).where(eq(approvals.id, id));
      }
      const denied = await request(sourceApp).post(`/api/companies/${source.id}/adm/capability/execute`).send({ capabilityToken });
      expect(denied.status).toBe(403);
      expect(denied.body).not.toHaveProperty("result");
      const foreign = sources[1]!;
      const foreignRead = await request(appFor(db, foreign)).get(`/api/adm/access-requests/${id}`);
      const missingRead = await request(appFor(db, foreign)).get(`/api/adm/access-requests/${randomUUID()}`);
      expect(foreignRead.status).toBe(404);
      expect(foreignRead.body).toEqual(missingRead.body);
      const foreignExecute = await request(appFor(db, foreign)).post(`/api/companies/${foreign.id}/adm/capability/execute`).send({ capabilityToken });
      expect(foreignExecute.status).toBe(403);
      expect(foreignExecute.body).not.toHaveProperty("result");
    }
  });
});
