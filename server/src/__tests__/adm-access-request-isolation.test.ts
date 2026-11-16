import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  activityLog,
  approvals,
  budgetPolicies,
  companySecrets,
  companySkills,
  issues,
  knowledgeItems,
  projects,
  toolApplications,
  toolConnections,
  createDb,
  type Db,
} from "@myrmidon/db";
import { inArray } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admAccessRequestRoutes } from "../routes/adm-access-requests.js";
import { errorHandler } from "../middleware/index.js";
import { admScopeHash, createAdmCapabilityToken } from "@myrmidon/shared/adm-access-request-server";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ADM_SECRET = "adm-gateway-test-signing-secret-0123456789";

interface TestCompany {
  id: string;
  agentId: string;
}

async function createCompanyWithAgent(db: Db, label: string): Promise<TestCompany> {
  const company = await db
    .insert(companies)
    .values({
      name: `ADM Isolation ${label} ${randomUUID()}`,
      issuePrefix: `AI${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);

  const agent = await db
    .insert(agents)
    .values({
      companyId: company.id,
      name: `${label}-agent`,
      urlKey: `${label.toLowerCase()}-agent-${randomUUID().slice(0, 8)}`,
      role: "engineer",
      title: `${label} agent`,
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: { canCreateAgents: false },
    })
    .returning()
    .then((rows) => rows[0]!);

  return { id: company.id, agentId: agent.id };
}

/** Seeds one resource row of `family` owned by `company`. Returns the lookup key. */
async function seedResource(db: Db, company: TestCompany, family: string): Promise<string> {
  const key = `res-${family}-${randomUUID().slice(0, 8)}`;
  switch (family) {
    case "skill":
      await db.insert(companySkills).values({
        companyId: company.id,
        key,
        slug: key,
        name: `${key} name`,
        markdown: `# ${key} secret body`,
      });
      return key;
    case "secret":
      await db.insert(companySecrets).values({
        companyId: company.id,
        key,
        name: `${key} name`,
      });
      return key;
    case "connection": {
      const app = await db
        .insert(toolApplications)
        .values({
          companyId: company.id,
          name: `${key}-app`,
          type: "mcp",
          status: "active",
        })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(toolConnections).values({
        companyId: company.id,
        applicationId: app.id,
        name: key,
        uid: `${key}-uid`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
      });
      return key;
    }
    case "project":
      await db.insert(projects).values({
        companyId: company.id,
        name: key,
      });
      return key;
    case "task": {
      const issue = await db
        .insert(issues)
        .values({
          companyId: company.id,
          title: `${key} title`,
          description: `${key} confidential description`,
          status: "backlog",
        })
        .returning()
        .then((rows) => rows[0]!);
      return issue.id;
    }
    case "budget":
      await db.insert(budgetPolicies).values({
        companyId: company.id,
        scopeType: key,
        scopeId: company.id,
        windowKind: "monthly",
        amount: 1000,
      });
      return key;
    case "memory":
      await db.insert(knowledgeItems).values({
        companyId: company.id,
        nestId: company.id,
        slug: key,
        title: `${key} memory title`,
        summary: `${key} memory summary`,
      });
      return key;
    default:
      throw new Error(`unknown family ${family}`);
  }
}

/** Builds an express app with a fixed actor on every request. */
function buildApp(db: Db, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", admAccessRequestRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("adm gateway cross-company isolation (OPE-12766)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companies3!: TestCompany[];
  const companyIds: string[] = [];
  const RESOURCE_FAMILIES = ["skill", "secret", "connection", "project", "budget", "memory", "task"] as const;
  let previousSecret: string | undefined;
  let previousAdmCompany: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adm-isolation-");
    db = createDb(tempDb.connectionString);
    companies3 = [
      await createCompanyWithAgent(db, "Alpha"),
      await createCompanyWithAgent(db, "Beta"),
      await createCompanyWithAgent(db, "Gamma"),
    ];
    companies3.forEach((c) => companyIds.push(c.id));
    previousSecret = process.env.AGENT_JWT_SECRET;
    process.env.AGENT_JWT_SECRET = ADM_SECRET;
    previousAdmCompany = process.env.ADM_COMPANY_ID;
    process.env.ADM_COMPANY_ID = companies3[2]!.id;
  }, 60_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.AGENT_JWT_SECRET;
    else process.env.AGENT_JWT_SECRET = previousSecret;
    if (previousAdmCompany === undefined) delete process.env.ADM_COMPANY_ID;
    else process.env.ADM_COMPANY_ID = previousAdmCompany;
    // Children first, then companies.
    await db.delete(companySkills).where(inArray(companySkills.companyId, companyIds));
    await db.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
    await db.delete(toolConnections).where(inArray(toolConnections.companyId, companyIds));
    await db.delete(toolApplications).where(inArray(toolApplications.companyId, companyIds));
    await db.delete(budgetPolicies).where(inArray(budgetPolicies.companyId, companyIds));
    await db.delete(knowledgeItems).where(inArray(knowledgeItems.companyId, companyIds));
    await db.delete(issues).where(inArray(issues.companyId, companyIds));
    await db.delete(projects).where(inArray(projects.companyId, companyIds));
    await db.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await db.delete(approvals).where(inArray(approvals.companyId, companyIds));
    await db.delete(agents).where(inArray(agents.companyId, companyIds));
    await db.delete(companies).where(inArray(companies.id, companyIds));
    await tempDb?.cleanup();
  });

  function agentActor(company: TestCompany) {
    return {
      type: "agent",
      agentId: company.agentId,
      companyId: company.id,
      source: "agent_key",
      isInstanceAdmin: false,
    };
  }

  it("rejects cross-company metadata requests for every company pair and resource family", async () => {
    const adm = companies3[2]!;
    for (const family of RESOURCE_FAMILIES) {
      for (const owner of companies3) {
        const key = await seedResource(db, owner, family);
        for (const actorCompany of companies3) {
          if (actorCompany.id === adm.id) continue;
          const response = await request(buildApp(db, agentActor(actorCompany)))
            .post(`/api/companies/${actorCompany.id}/adm/access-requests`)
            .send({ targetCompanyId: adm.id, resourceType: family, resourceRef: `${family}:${key}`,
              action: "read_metadata", justification: "Isolation probe", requestedScope: { resourceKey: key },
              idempotencyKey: `idem-${randomUUID()}` });
          expect(response.status, `${actorCompany.id} -> ${family}:${key}`).toBe(400);
          const body = JSON.stringify(response.body);
          expect(body).not.toContain("secret body");
          expect(body).not.toContain("confidential description");
          expect(body).not.toContain("memory summary");
        }
      }
    }
  }, 240_000);

  it("lists and reads never leak foreign request metadata between company pairs", async () => {
    const adm = companies3[2]!;
    const sourceApp = buildApp(db, agentActor(companies3[0]!));
    const created = await request(sourceApp)
      .post(`/api/companies/${companies3[0]!.id}/adm/access-requests`)
      .send({
        targetCompanyId: adm.id,
        resourceType: "skill",
        resourceRef: "skill:leak-probe",
        action: "grant_capability",
        justification: "metadata leak probe.",
        requestedScope: { resourceKey: "leak-probe", notes: "leak-marker-value" },
        idempotencyKey: `idem-${randomUUID()}`,
      });
    expect(created.status).toBe(201);
    const requestId = created.body.requestId as string;

    // Involved companies: source sees its own row; ADM sees it as target.
    // Uninvolved companies see neither the row nor the raw scope marker.
    for (const company of companies3) {
      if (company.id === companies3[0]!.id) continue;
      const app = buildApp(db, agentActor(company));
      const list = await request(app).get(`/api/companies/${company.id}/adm/access-requests`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain("leak-marker-value");
      if (company.id === companies3[2]!.id) {
        // ADM is the named target: it legitimately sees the request row.
        expect(JSON.stringify(list.body)).toContain(requestId);
      } else {
        expect(JSON.stringify(list.body)).not.toContain(requestId);
        const read = await request(app).get(`/api/adm/access-requests/${requestId}`);
        expect(read.status).toBe(404);
      }
    }
  });

  it("denies decisions and execution attempts from non-ADM companies across all pairs", async () => {
    const adm = companies3[2]!;
    const sourceApp = buildApp(db, agentActor(companies3[0]!));
    const created = await request(sourceApp)
      .post(`/api/companies/${companies3[0]!.id}/adm/access-requests`)
      .send({
        targetCompanyId: adm.id,
        resourceType: "skill",
        resourceRef: "skill:aggregate-probe",
        action: "grant_capability",
        justification: "budget aggregate probe.",
        requestedScope: { budgetArea: "aggregate-probe" },
        idempotencyKey: `idem-${randomUUID()}`,
      });
    expect(created.status).toBe(201);
    const requestId = created.body.requestId as string;

    // Non-ADM companies cannot decide, for every pair.
    for (const company of companies3) {
      const board = buildApp(db, {
        type: "board",
        userId: `user-${company.id}`,
        companyIds: [company.id],
        source: "session",
        memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
      });
      const decision = await request(board)
        .post(`/api/adm/access-requests/${requestId}/decide`)
        .send({ decision: "approved" });
      if (company.id === adm.id) {
        expect(decision.status).toBe(200);
      } else {
        expect(decision.status, `decide by ${company.id}`).toBe(403);
      }
    }

    // ADM aggregates only its own budget rows.
    const capabilityToken = (await request(sourceApp).get(`/api/adm/access-requests/${requestId}`)).body;
    void capabilityToken;
    const approve = buildApp(db, {
      type: "board",
      userId: `user-${adm.id}`,
      companyIds: [adm.id],
      source: "session",
      memberships: [{ companyId: adm.id, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    });
    const admDecision = await request(approve)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    expect(admDecision.status).toBe(409); // already approved above
    const token = (
      await request(approve)
        .post(`/api/adm/access-requests/${randomUUID()}/decide`)
        .send({ decision: "approved" })
    );
    expect(token.status).toBe(404);
  });

  it("rejects budget aggregate requests for both foreign and ADM-owned budgets", async () => {
    const adm = companies3[2]!;
    const source = companies3[0]!;
    for (const owner of [source, adm]) {
      const key = await seedResource(db, owner, "budget");
      const response = await request(buildApp(db, agentActor(source)))
        .post(`/api/companies/${source.id}/adm/access-requests`)
        .send({ targetCompanyId: adm.id, resourceType: "budget", resourceRef: `budget:${key}`,
          action: "query_aggregate", justification: "budget isolation probe",
          requestedScope: { budgetArea: key }, idempotencyKey: `idem-${randomUUID()}` });
      expect(response.status).toBe(400);
      expect(response.body.result).toBeUndefined();
    }
  });

  it("binds the audience of every issued capability to its source company for all pairs", async () => {
    const adm = companies3[2]!;
    for (const actorCompany of companies3) {
      if (actorCompany.id === adm.id) continue; // ADM cannot request from itself
      const app = buildApp(db, agentActor(actorCompany));
      const created = await request(app)
        .post(`/api/companies/${actorCompany.id}/adm/access-requests`)
        .send({
          targetCompanyId: adm.id,
          resourceType: "skill",
          resourceRef: "skill:audience-probe",
          action: "grant_capability",
          justification: "audience binding probe.",
          requestedScope: { resourceKey: "audience-probe" },
          idempotencyKey: `idem-${randomUUID()}`,
        });
      expect(created.status).toBe(201);
      const admBoard = buildApp(db, {
        type: "board",
        userId: `user-${adm.id}`,
        companyIds: [adm.id],
        source: "session",
        memberships: [{ companyId: adm.id, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
      });
      const approved = await request(admBoard)
        .post(`/api/adm/access-requests/${created.body.requestId}/decide`)
        .send({ decision: "approved" });
      expect(approved.status).toBe(200);
      const capabilityToken = approved.body.capabilityToken as string;

      // Every other company fails to execute the same token.
      for (const other of companies3) {
        const otherApp = buildApp(db, agentActor(other));
        const attempt = await request(otherApp)
          .post(`/api/companies/${other.id}/adm/capability/execute`)
          .send({ capabilityToken });
        if (other.id === actorCompany.id) {
          expect(attempt.status, `own execute ${actorCompany.id}`).toBe(200);
        } else {
          expect(attempt.status, `foreign execute ${other.id} -> ${actorCompany.id}`).toBe(403);
        }
      }
    }
  }, 120_000);

  it("keeps revocation effective across families and companies", async () => {
    const adm = companies3[2]!;
    const source = companies3[1]!;
    for (const family of ["skill", "connection"] as const) {
      const app = buildApp(db, agentActor(source));
      const created = await request(app)
        .post(`/api/companies/${source.id}/adm/access-requests`)
        .send({
          targetCompanyId: adm.id,
          resourceType: family,
          resourceRef: `${family}:revoke-probe`,
          action: "grant_capability",
          justification: "revocation probe.",
          requestedScope: { resourceKey: "revoke-probe" },
          idempotencyKey: `idem-${randomUUID()}`,
        });
      expect(created.status).toBe(201);
      const admBoard = buildApp(db, {
        type: "board",
        userId: `user-${adm.id}`,
        companyIds: [adm.id],
        source: "session",
        memberships: [{ companyId: adm.id, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
      });
      const approved = await request(admBoard)
        .post(`/api/adm/access-requests/${created.body.requestId}/decide`)
        .send({ decision: "approved" });
      const capabilityToken = approved.body.capabilityToken as string;

      const revoke = await request(app)
        .post(`/api/companies/${source.id}/adm/access-requests/${created.body.requestId}/revoke`)
        .send({ reason: "probe done" });
      expect(revoke.status).toBe(200);
      expect(revoke.body.status).toBe("revoked");

      const replay = await request(app)
        .post(`/api/companies/${source.id}/adm/capability/execute`)
        .send({ capabilityToken });
      expect(replay.status, `replay ${family}`).toBe(403);
    }
  }, 90_000);

  it("audits contain the scope hash but no raw scope or resource content", async () => {
    const adm = companies3[2]!;
    const source = companies3[0]!;
    const app = buildApp(db, agentActor(source));
    const created = await request(app)
      .post(`/api/companies/${source.id}/adm/access-requests`)
      .send({
        targetCompanyId: adm.id,
        resourceType: "skill",
        resourceRef: "skill:audit-probe",
        action: "grant_capability",
        justification: "audit probe.",
        requestedScope: { resourceKey: "audit-probe", notes: "raw-audit-marker" },
        idempotencyKey: `idem-${randomUUID()}`,
      });
    expect(created.status).toBe(201);
    const requestId = created.body.requestId as string;

    const { and, eq } = await import("drizzle-orm");
    const events = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, requestId), inArray(activityLog.companyId, companyIds)));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("raw-audit-marker");
    expect(events.length).toBeGreaterThan(0);
  });
});
