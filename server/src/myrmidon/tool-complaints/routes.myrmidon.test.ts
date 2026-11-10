// myrmidon(1.7 TOOL-COMPLAINTS-API, OPE-12228): the agent tool-complaint
// channel — routes tests.
//
// Runs against the real routes, the real actorMiddleware and an embedded
// Postgres, so the full mounted path is exercised: an agent presents a bearer
// agent API key that the middleware resolves through agent_api_keys (201 on
// POST, activity-log row written); a request without a bearer or with an
// unknown bearer is refused by the middleware itself (401); a second company
// never sees the first company's feed (company isolation); the board lists
// one company's complaints with statuses.
//
// Neutral data only: agent-a ids, example.com.

import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
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
import { actorMiddleware } from "../../middleware/auth.js";
import { toolComplaintRoutes } from "./routes.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
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

/**
 * Create a real agent_api_keys row and return the raw token. The middleware
 * hashes the presented bearer and looks it up in agent_api_keys, so the test
 * exercises the same path a production agent request travels.
 */
async function createAgentKey(db: Db, companyId: string, agentId: string) {
  const token = `pcp_test_tool_complaints_${randomUUID()}`;
  const key = await db
    .insert(agentApiKeys)
    .values({
      companyId,
      agentId,
      name: `key-${randomUUID().slice(0, 8)}`,
      keyHash: hashToken(token),
      responsibleUserId: "user-a",
    })
    .returning()
    .then((rows) => rows[0]!);
  return { token, key };
}

function createApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
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
    await db.delete(agentApiKeys);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("an agent with a valid bearer agent key files a complaint: 201, company-stamped, activity-logged", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { token } = await createAgentKey(db, company.id, agent.id);

    const res = await request(createApp(db))
      .post("/api/myrmidon/tool-complaints")
      .set("Authorization", `Bearer ${token}`)
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
    // The responsible user of the agent key that authenticated the request is stamped.
    expect(logs[0]!.responsibleUserId).toBe("user-a");
  });

  it("a request without a bearer token is refused: 401, no row", async () => {
    const company = await createCompany(db);
    await createAgent(db, company.id);

    const res = await request(createApp(db))
      .post("/api/myrmidon/tool-complaints")
      .send({ tool: "github_create_issue", issue: "no key here", severity: "low" });

    expect(res.status).toBe(401);
    expect(await db.select().from(toolComplaints)).toHaveLength(0);
  });

  it("a request with an unknown bearer token is refused: 401, no row", async () => {
    const company = await createCompany(db);
    await createAgent(db, company.id);

    const res = await request(createApp(db))
      .post("/api/myrmidon/tool-complaints")
      .set("Authorization", "Bearer pcp_test_unknown_key_that_does_not_exist")
      .send({ tool: "github_create_issue", issue: "bad key", severity: "low" });

    expect(res.status).toBe(401);
    expect(await db.select().from(toolComplaints)).toHaveLength(0);
  });

  it("a board session cannot file a complaint through the agent route: 401", async () => {
    const company = await createCompany(db);
    await createAgent(db, company.id);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "user-a",
      status: "active",
      membershipRole: "owner",
    });

    // A session-resolving actorMiddleware yields a board actor; the route
    // refuses it because only an agent can file a complaint.
    const app = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          user: { id: "user-a" },
          session: { id: "session-a" },
        }),
      }),
    );
    app.use("/api", toolComplaintRoutes(db));
    app.use(errorHandler);

    const res = await request(app)
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
    const keyA = await createAgentKey(db, companyA.id, agentA.id);
    const keyB = await createAgentKey(db, companyB.id, agentB.id);

    const filed = await request(createApp(db))
      .post("/api/myrmidon/tool-complaints")
      .set("Authorization", `Bearer ${keyA.token}`)
      .send({ tool: "jira_search", issue: "timeouts", severity: "critical" });
    expect(filed.status).toBe(201);

    // Company B's agent reads its own feed: empty, the complaint never
    // crosses the company boundary.
    const feedB = await request(createApp(db))
      .get("/api/myrmidon/tool-complaints")
      .set("Authorization", `Bearer ${keyB.token}`);
    expect(feedB.status).toBe(200);
    expect(feedB.body.complaints).toEqual([]);

    // Company B's board reads its own feed: also empty.
    await db.insert(companyMemberships).values({
      companyId: companyB.id,
      principalType: "user",
      principalId: "user-board-b",
      status: "active",
      membershipRole: "owner",
    });
    const boardApp = express();
    boardApp.use(express.json());
    boardApp.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          user: { id: "user-board-b" },
          session: { id: "session-b" },
        }),
      }),
    );
    boardApp.use("/api", toolComplaintRoutes(db));
    boardApp.use(errorHandler);
    const boardFeedB = await request(boardApp)
      .get("/api/myrmidon/tool-complaints")
      .query({ companyId: companyB.id });
    expect(boardFeedB.status).toBe(200);
    expect(boardFeedB.body.complaints).toEqual([]);

    // Company A's agent sees its own complaint.
    const feedA = await request(createApp(db))
      .get("/api/myrmidon/tool-complaints")
      .set("Authorization", `Bearer ${keyA.token}`);
    expect(feedA.status).toBe(200);
    expect(feedA.body.complaints).toHaveLength(1);
    expect(feedA.body.complaints[0].id).toBe(filed.body.id);
  });

  it("invalid payloads are rejected: 400/422 and no row, no activity", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { token } = await createAgentKey(db, company.id, agent.id);

    const res = await request(createApp(db))
      .post("/api/myrmidon/tool-complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({ tool: "x", issue: "", severity: "nuclear" });
    expect([400, 422]).toContain(res.status);
    expect(await db.select().from(toolComplaints)).toHaveLength(0);
  });

  it("an activity-log failure rolls the complaint back: no row, no audit", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { token } = await createAgentKey(db, company.id, agent.id);

    // A runId that does not exist violates the activity_log.run_id foreign
    // key, so the mandatory audit insert fails inside the same transaction
    // as the complaint insert. The behavioral contract: the mutation must
    // not land without its activity-log entry.
    const res = await request(createApp(db))
      .post("/api/myrmidon/tool-complaints")
      .set("Authorization", `Bearer ${token}`)
      .send({
        tool: "github_create_issue",
        issue: "audit must not be losable",
        severity: "high",
        runId: randomUUID(),
      });

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(500);
    expect(await db.select().from(toolComplaints)).toHaveLength(0);
    const logs = await db
      .select()
      .from(activityLog)
      .then((r) => r.filter((l) => l.action === TOOL_COMPLAINT_CREATED_ACTION));
    expect(logs).toHaveLength(0);
  });
});
