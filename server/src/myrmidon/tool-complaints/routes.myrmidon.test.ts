// myrmidon(1.7 TOOL-COMPLAINTS-API, OPE-12228): the agent tool-complaint
// channel — routes tests.
//
// Runs against the real routes and an embedded Postgres, so the full path is
// exercised: an agent with a bearer agent key files a complaint (201) and an
// activity-log row is written; a request without an agent actor is refused
// (401); a second company never sees the first company's feed (company
// isolation); the board lists one company's complaints with statuses.
//
// Neutral data only: agent-a ids, example.com.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  toolComplaints,
} from "@myrmidon/db";
import { TOOL_COMPLAINT_CREATED_ACTION } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { toolComplaintRoutes } from "./routes.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function agentActor(companyId: string, agentId: string, keyId?: string): Express.Request["actor"] {
  return {
    type: "agent",
    source: "agent_key",
    agentId,
    companyId,
    ...(keyId ? { keyId } : {}),
  } as Express.Request["actor"];
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
  } as Express.Request["actor"];
}

function noneActor(): Express.Request["actor"] {
  return { type: "none", source: "none" } as unknown as Express.Request["actor"];
}

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({ name: `company-${randomUUID().slice(0, 8)}`, issuePrefix: `TC${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `agent-${randomUUID().slice(0, 8)}`,
      role: "engineer",
      permissions: {},
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", toolComplaintRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("myrmidon(1.7 TOOL-COMPLAINTS-API) tool complaints", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-tool-complaints-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolComplaints);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("an agent with a key files a complaint: 201, company-stamped, activity-logged", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const res = await request(createApp(db, agentActor(company.id, agent.id, randomUUID())))
      .post("/api/myrmidon/tool-complaints")
      .send({ tool: "github_create_issue", issue: "schema drift on 422", severity: "high" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.agentId).toBe(agent.id);
    expect(res.body.tool).toBe("github_create_issue");
    expect(res.body.severity).toBe("high");
    expect(res.body.status).toBe("open");

    const rows = await db.select().from(toolComplaints);
    expect(rows).toHaveLength(1);

    const logs = await db
      .select()
      .from(activityLog)
      .then((r) => r.filter((l) => l.action === TOOL_COMPLAINT_CREATED_ACTION));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.companyId).toBe(company.id);
    expect(logs[0]!.agentId).toBe(agent.id);
    expect(logs[0]!.entityType).toBe("tool_complaint");
    expect(logs[0]!.entityId).toBe(rows[0]!.id);
  });

  it("a request without a valid agent actor cannot create a complaint: 401", async () => {
    const company = await createCompany(db);
    const res = await request(createApp(db, noneActor()))
      .post("/api/myrmidon/tool-complaints")
      .send({ tool: "github_create_issue", issue: "no key here", severity: "low" });
    expect(res.status).toBe(401);
    expect(await db.select().from(toolComplaints)).toHaveLength(0);
  });

  it("a board actor cannot file a complaint through the agent route: 401", async () => {
    const company = await createCompany(db);
    const res = await request(createApp(db, boardActor(company.id)))
      .post("/api/myrmidon/tool-complaints")
      .send({ tool: "github_create_issue", issue: "board tried", severity: "low" });
    expect(res.status).toBe(401);
    expect(await db.select().from(toolComplaints)).toHaveLength(0);
  });

  it("complaints of one company are not visible to another company", async () => {
    const companyA = await createCompany(db);
    const companyB = await createCompany(db);
    const agentA = await createAgent(db, companyA.id);
    const agentB = await createAgent(db, companyB.id);

    const filed = await request(createApp(db, agentActor(companyA.id, agentA.id)))
      .post("/api/myrmidon/tool-complaints")
      .send({ tool: "jira_search", issue: "timeouts", severity: "critical" });
    expect(filed.status).toBe(201);

    // Company B's agent reads its own feed: empty, the complaint never
    // crosses the company boundary.
    const feedB = await request(createApp(db, agentActor(companyB.id, agentB.id)))
      .get("/api/myrmidon/tool-complaints");
    expect(feedB.status).toBe(200);
    expect(feedB.body.complaints).toEqual([]);

    // Company B's board reads its own feed: also empty.
    await db.insert(companyMemberships).values({
      companyId: companyB.id,
      principalType: "user",
      principalId: "user-a",
      status: "active",
      membershipRole: "owner",
    });
    const boardFeedB = await request(createApp(db, boardActor(companyB.id)))
      .get("/api/myrmidon/tool-complaints");
    expect(boardFeedB.status).toBe(200);
    expect(boardFeedB.body.complaints).toEqual([]);

    // Company A's agent sees its own complaint.
    const feedA = await request(createApp(db, agentActor(companyA.id, agentA.id)))
      .get("/api/myrmidon/tool-complaints");
    expect(feedA.status).toBe(200);
    expect(feedA.body.complaints).toHaveLength(1);
    expect(feedA.body.complaints[0].id).toBe(filed.body.id);
  });

  it("invalid payloads are rejected: 400/422 and no row, no activity", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const res = await request(createApp(db, agentActor(company.id, agent.id)))
      .post("/api/myrmidon/tool-complaints")
      .send({ tool: "x", issue: "", severity: "nuclear" });
    expect([400, 422]).toContain(res.status);
    expect(await db.select().from(toolComplaints)).toHaveLength(0);
  });
});
