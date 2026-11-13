import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  activityLog,
  approvals,
  createDb,
  type Db,
} from "@myrmidon/db";
import { eq, inArray } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admAccessRequestRoutes } from "../routes/adm-access-requests.js";
import { errorHandler } from "../middleware/index.js";
import { admAccessRequestService, type AdmCapabilityExecutor } from "../services/adm-access-request.js";
import { admScopeHash, createAdmCapabilityToken } from "@myrmidon/shared/adm-access-request-server";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ADM_SECRET = "adm-gateway-test-signing-secret-0123456789";

interface TestCompany {
  id: string;
  agentId: string;
  keyToken: string;
}

async function createCompanyWithAgent(db: Db, label: string): Promise<TestCompany> {
  const company = await db
    .insert(companies)
    .values({
      name: `ADM Gateway ${label} ${randomUUID()}`,
      issuePrefix: `AG${randomUUID().slice(0, 6).toUpperCase()}`,
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

  return { id: company.id, agentId: agent.id, keyToken: "" };
}

/** Builds an express app with a fixed actor on every request. */
function buildApp(
  db: Db,
  actor: Record<string, unknown>,
  capabilityExecutor?: AdmCapabilityExecutor,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", admAccessRequestRoutes(db, { capabilityExecutor }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("adm access request gateway (OPE-12766)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sourceCompany!: TestCompany;
  let targetCompany!: TestCompany;
  let thirdCompany!: TestCompany;
  const cleanupCompanies: string[] = [];
  let previousSecret: string | undefined;
  let previousAdmCompany: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adm-access-request-");
    db = createDb(tempDb.connectionString);
    sourceCompany = await createCompanyWithAgent(db, "Source");
    targetCompany = await createCompanyWithAgent(db, "Target");
    thirdCompany = await createCompanyWithAgent(db, "Third");
    cleanupCompanies.push(sourceCompany.id, targetCompany.id, thirdCompany.id);
    previousSecret = process.env.AGENT_JWT_SECRET;
    process.env.AGENT_JWT_SECRET = ADM_SECRET;
    previousAdmCompany = process.env.ADM_COMPANY_ID;
    process.env.ADM_COMPANY_ID = targetCompany.id;
  }, 20_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.AGENT_JWT_SECRET;
    else process.env.AGENT_JWT_SECRET = previousSecret;
    if (previousAdmCompany === undefined) delete process.env.ADM_COMPANY_ID;
    else process.env.ADM_COMPANY_ID = previousAdmCompany;
    // Audit and approval rows reference agents/companies — clear them first.
    await db.delete(activityLog).where(inArray(activityLog.companyId, cleanupCompanies));
    await db.delete(approvals).where(inArray(approvals.companyId, cleanupCompanies));
    await db.delete(agents).where(inArray(agents.companyId, cleanupCompanies));
    await db.delete(companies).where(inArray(companies.id, cleanupCompanies));
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

  function boardActorFor(company: TestCompany) {
    return {
      type: "board",
      userId: `user-${company.id}`,
      companyIds: [company.id],
      source: "session",
      memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    };
  }

  function createRequestBody(overrides: Record<string, unknown> = {}) {
    return {
      targetCompanyId: targetCompany.id,
      resourceType: "skill",
      resourceRef: "skill:atlas-report",
      action: "read_metadata",
      justification: "Need the approved skill catalog metadata for a report.",
      requestedScope: { resourceKey: "atlas-report" },
      idempotencyKey: `idem-${randomUUID()}`,
      ...overrides,
    };
  }

  it("allows an in-company agent to create a request against the ADM company", async () => {
    const app = buildApp(db, agentActor(sourceCompany));
    const response = await request(app)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody());
    expect(response.status).toBe(201);
    expect(response.body.status).toBe("pending");
    expect(response.body.sourceCompanyId).toBe(sourceCompany.id);
    expect(response.body.targetCompanyId).toBe(targetCompany.id);
    // Redacted projection: no raw scope, no capability material.
    expect(JSON.stringify(response.body)).not.toContain("atlas-report-scope-raw");
  });

  it("denies an agent of company B creating a request in company A for every company pair", async () => {
    const pairs: Array<[TestCompany, TestCompany]> = [
      [targetCompany, sourceCompany],
      [thirdCompany, sourceCompany],
      [thirdCompany, targetCompany],
      [sourceCompany, targetCompany], // same company but the wrong route company vs actor is covered elsewhere
    ];
    for (const [acting, owner] of pairs) {
      if (acting.id === owner.id) continue;
      const app = buildApp(db, agentActor(acting));
      const response = await request(app)
        .post(`/api/companies/${owner.id}/adm/access-requests`)
        .send(createRequestBody());
      expect(response.status, `${acting.id} -> ${owner.id}`).toBe(403);
    }
  });

  it("denies an agent posting under its own company id with a foreign agent identity mismatch", async () => {
    // Agent of target company cannot use the source company's route namespace.
    const app = buildApp(db, agentActor(targetCompany));
    const response = await request(app)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody());
    expect(response.status).toBe(403);
  });

  it("rejects scope payloads smuggling credentials or URLs", async () => {
    const app = buildApp(db, agentActor(sourceCompany));
    const smuggleCases = [
      { apiToken: "pcp_live_super_secret" },
      { callbackEndpoint: "https://evil.example.com/exfil" },
      { notes: "reach me at http://169.254.169.254/latest" },
      { secretRef: "vault://prod/db" },
      { resourceKey: "innocent", nestedNote: "see https://attacker.io" },
    ];
    for (const requestedScope of smuggleCases) {
      const response = await request(app)
        .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
        .send(createRequestBody({ requestedScope }));
      expect(response.status, JSON.stringify(requestedScope)).toBe(400);
    }
    // Unknown keys are also denied by the allowlist.
    const response = await request(app)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody({ requestedScope: { arbitraryKey: "value" } }));
    expect(response.status).toBe(400);
  });

  it("denies cross-company reads and keeps the existence oracle closed", async () => {
    const sourceApp = buildApp(db, agentActor(sourceCompany));
    const created = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody());
    const requestId = created.body.requestId as string;
    expect(requestId).toBeTruthy();

    // Same-company read works.
    const own = await request(sourceApp).get(`/api/adm/access-requests/${requestId}`);
    expect(own.status).toBe(200);

    // Foreign agents and foreign board companies read: identical 404 (no oracle).
    const foreignAgent = buildApp(db, agentActor(thirdCompany));
    const foreignAgentRead = await request(foreignAgent).get(`/api/adm/access-requests/${requestId}`);
    expect(foreignAgentRead.status).toBe(404);
    expect(foreignAgentRead.body).toEqual({ error: "Access request not found" });

    const foreignBoard = buildApp(db, boardActorFor(thirdCompany));
    const foreignBoardRead = await request(foreignBoard).get(`/api/adm/access-requests/${requestId}`);
    expect(foreignBoardRead.status).toBe(404);
    expect(foreignBoardRead.body).toEqual({ error: "Access request not found" });

    const randomId = randomUUID();
    const missingRead = await request(foreignBoard).get(`/api/adm/access-requests/${randomId}`);
    expect(missingRead.status).toBe(404);
    expect(missingRead.body).toEqual({ error: "Access request not found" });
  });

  it("lets only the ADM company decide, and approves with a capability token", async () => {
    const sourceApp = buildApp(db, agentActor(sourceCompany));
    const created = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody());
    const requestId = created.body.requestId as string;

    // Source company cannot self-approve.
    const sourceBoard = buildApp(db, boardActorFor(sourceCompany));
    const selfApprove = await request(sourceBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    expect(selfApprove.status).toBe(403);

    // Third company cannot approve either.
    const thirdBoard = buildApp(db, boardActorFor(thirdCompany));
    const thirdApprove = await request(thirdBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    expect(thirdApprove.status).toBe(403);

    // Target (ADM) company board approves.
    const admBoard = buildApp(db, boardActorFor(targetCompany));
    const approve = await request(admBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved", reason: "approved for one read" });
    expect(approve.status).toBe(200);
    expect(approve.body.request.status).toBe("approved");
    expect(typeof approve.body.capabilityToken).toBe("string");

    // Decision is terminal: second approve conflicts.
    const secondApprove = await request(admBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    expect(secondApprove.status).toBe(409);
    return { requestId, capabilityToken: approve.body.capabilityToken as string };
  });

  it("audits creation on both companies with scope hash instead of raw scope", async () => {
    const scope = { resourceKey: "audit-probe", notes: "audit trail check" };
    const sourceApp = buildApp(db, agentActor(sourceCompany));
    const created = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody({ requestedScope: scope }));
    const requestId = created.body.requestId as string;

    const sourceEvents = await db
      .select()
      .from(activityLog)
      .where((await import("drizzle-orm")).and(
        (await import("drizzle-orm")).eq(activityLog.entityId, requestId),
        (await import("drizzle-orm")).eq(activityLog.companyId, sourceCompany.id),
      ));
    const targetEvents = await db
      .select()
      .from(activityLog)
      .where((await import("drizzle-orm")).and(
        (await import("drizzle-orm")).eq(activityLog.entityId, requestId),
        (await import("drizzle-orm")).eq(activityLog.companyId, targetCompany.id),
      ));
    expect(sourceEvents.some((event) => event.action === "adm_access_request.created")).toBe(true);
    expect(targetEvents.some((event) => event.action === "adm_access_request.received")).toBe(true);
    const rawScopeLeak = JSON.stringify([...sourceEvents, ...targetEvents]);
    expect(rawScopeLeak).not.toContain("audit-probe");
    expect(rawScopeLeak).toContain(admScopeHash(scope));
  });

  it("executes an approved capability from the source company only, and denies after revoke", async () => {
    // Real controlled executor: invokes through the (stubbed) tool gateway and
    // reports honest outcomes. Arguments come from the approved scope.
    const executedInvocations: Array<Record<string, unknown>> = [];
    const executor: AdmCapabilityExecutor = {
      async execute(input) {
        executedInvocations.push(input as unknown as Record<string, unknown>);
        return {
          executed: true,
          result: {
            kind: "tool_execution_result",
            status: "succeeded",
            invocationId: "invocation-under-test",
          },
        };
      },
    };
    const sourceApp = buildApp(db, agentActor(sourceCompany), executor);
    const created = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody({ action: "invoke_tool", resourceRef: "tool:geo-lookup", requestedScope: { resourceKey: "geo-lookup", operationKind: "invoke" } }));
    const requestId = created.body.requestId as string;

    const admBoard = buildApp(db, boardActorFor(targetCompany));
    const approve = await request(admBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    const capabilityToken = approve.body.capabilityToken as string;
    expect(capabilityToken).toBeTruthy();

    // Foreign company cannot execute the capability (audience mismatch) and
    // must not trigger any execution.
    const foreignApp = buildApp(db, agentActor(thirdCompany), executor);
    const foreignExecute = await request(foreignApp)
      .post(`/api/companies/${thirdCompany.id}/adm/capability/execute`)
      .send({ capabilityToken });
    expect(foreignExecute.status).toBe(403);
    expect(executedInvocations).toHaveLength(0);

    // Source company executes through the gateway executor.
    const execute = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/capability/execute`)
      .send({ capabilityToken });
    expect(execute.status).toBe(200);
    expect(execute.body.executed).toBe(true);
    expect(execute.body.result.kind).toBe("tool_execution_result");
    expect(executedInvocations).toHaveLength(1);
    expect((executedInvocations[0] as { resourceKey: string }).resourceKey).toBe("geo-lookup");
    expect((executedInvocations[0] as { actor: { companyId: string } }).actor.companyId).toBe(sourceCompany.id);

    // Replay after revoke is denied.
    const revoke = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests/${requestId}/revoke`)
      .send({ reason: "work finished" });
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe("revoked");

    const replay = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/capability/execute`)
      .send({ capabilityToken });
    expect(replay.status).toBe(403);
    expect(executedInvocations).toHaveLength(1);
  });

  it("invoke_tool without a configured executor is denied, never acknowledged", async () => {
    const sourceApp = buildApp(db, agentActor(sourceCompany));
    const created = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody({ action: "invoke_tool", resourceRef: "tool:no-executor", requestedScope: { resourceKey: "no-executor", operationKind: "invoke" } }));
    const requestId = created.body.requestId as string;
    const admBoard = buildApp(db, boardActorFor(targetCompany));
    const approve = await request(admBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    const capabilityToken = approve.body.capabilityToken as string;
    expect(capabilityToken).toBeTruthy();

    const execute = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/capability/execute`)
      .send({ capabilityToken });
    expect(execute.status).toBe(403);
    const denialAudit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, requestId));
    expect(denialAudit.some((event) => event.action === "adm_access_request.executed")).toBe(false);
  });

  it("capability executor that did not execute is audited as denied and returns 403", async () => {
    const refusingExecutor: AdmCapabilityExecutor = {
      async execute() {
        return { executed: false, result: { kind: "tool_execution_result", status: "denied", reason: "tool_connection_not_found" } };
      },
    };
    const sourceApp = buildApp(db, agentActor(sourceCompany), refusingExecutor);
    const created = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody({ action: "invoke_tool", resourceRef: "tool:missing-conn", requestedScope: { resourceKey: "missing-conn", operationKind: "invoke" } }));
    const requestId = created.body.requestId as string;
    const admBoard = buildApp(db, boardActorFor(targetCompany));
    const approve = await request(admBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    const capabilityToken = approve.body.capabilityToken as string;

    const execute = await request(sourceApp)
      .post(`/api/companies/${sourceCompany.id}/adm/capability/execute`)
      .send({ capabilityToken });
    expect(execute.status).toBe(403);

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, requestId));
    const denied = audit.find((event) => event.action === "adm_access_request.execution_denied");
    expect(denied).toBeTruthy();
    expect((denied?.details as { outcome?: string } | null)?.outcome).toBe("denied");
    const successAudit = audit.find((event) => event.action === "adm_access_request.executed");
    expect(successAudit).toBeFalsy();
  });

  it("denies execution when the capability resource is outside the approved scope", async () => {
    // Forge a capability whose claims do not match the approved request scope:
    // the token signs a different resourceKey than the stored requestedScope.
    const created = await request(buildApp(db, agentActor(sourceCompany)))
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody({ action: "read_metadata", resourceRef: "skill:atlas-report", requestedScope: { resourceKey: "atlas-report" } }));
    const requestId = created.body.requestId as string;
    const admBoard = buildApp(db, boardActorFor(targetCompany));
    const approve = await request(admBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    expect(approve.status).toBe(200);

    // Mint a validly-signed token but for a scope that was never approved.
    const forgedScope = { resourceKey: "other-skill" };
    const issued = createAdmCapabilityToken({
      requestId,
      sourceCompanyId: sourceCompany.id,
      targetCompanyId: targetCompany.id,
      requesterType: "agent",
      requesterId: sourceCompany.agentId,
      resourceType: "skill",
      resourceRef: "skill:other-skill",
      action: "read_metadata",
      scopeHash: admScopeHash(forgedScope),
      ttlSeconds: 300,
    });
    expect(issued).not.toBeNull();

    const execute = await request(buildApp(db, agentActor(sourceCompany)))
      .post(`/api/companies/${sourceCompany.id}/adm/capability/execute`)
      .send({ capabilityToken: issued!.token });
    expect(execute.status).toBe(403);
  });

  it("bounds action returns a bounded projection, never raw content", async () => {
    const app = buildApp(db, agentActor(sourceCompany));
    const created = await request(app)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(createRequestBody({ action: "bounds", resourceRef: "skill:bounded-skill", requestedScope: { resourceKey: "bounded-skill", operationKind: "bounds" } }));
    const requestId = created.body.requestId as string;
    const admBoard = buildApp(db, boardActorFor(targetCompany));
    const approve = await request(admBoard)
      .post(`/api/adm/access-requests/${requestId}/decide`)
      .send({ decision: "approved" });
    const capabilityToken = approve.body.capabilityToken as string;

    const execute = await request(app)
      .post(`/api/companies/${sourceCompany.id}/adm/capability/execute`)
      .send({ capabilityToken });
    expect(execute.status).toBe(200);
    expect(execute.body.executed).toBe(true);
    expect(execute.body.result.kind).toBe("resource_bounds");
    expect(execute.body.result.available).toBe(false);
    const serialized = JSON.stringify(execute.body.result);
    expect(serialized).not.toContain("markdown");
  });

  it("denies execution of a forged or foreign-audience capability", async () => {
    const issued = createAdmCapabilityToken({
      requestId: randomUUID(),
      sourceCompanyId: thirdCompany.id,
      targetCompanyId: targetCompany.id,
      requesterType: "agent",
      requesterId: thirdCompany.agentId,
      resourceType: "secret",
      resourceRef: "secret:prod-db",
      action: "grant_capability",
      scopeHash: admScopeHash({ resourceKey: "prod-db" }),
      ttlSeconds: 300,
    });
    expect(issued).not.toBeNull();
    // thirdCompany acts in its own namespace but the token belongs to third company
    // while the request record does not exist as approved — service must deny.
    const thirdApp = buildApp(db, agentActor(thirdCompany));
    const execute = await request(thirdApp)
      .post(`/api/companies/${thirdCompany.id}/adm/capability/execute`)
      .send({ capabilityToken: issued!.token });
    expect(execute.status).toBe(403);
  });

  it("is idempotent on repeated create with the same idempotency key", async () => {
    const app = buildApp(db, agentActor(sourceCompany));
    const body = createRequestBody();
    const first = await request(app)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(body);
    const second = await request(app)
      .post(`/api/companies/${sourceCompany.id}/adm/access-requests`)
      .send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.requestId).toBe(first.body.requestId);
    expect(second.body.isExisting).toBe(true);
  });
});
