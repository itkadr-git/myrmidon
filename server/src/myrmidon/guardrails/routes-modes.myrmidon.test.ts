// myrmidon(1.7-GRD-MODES): route tests for the settings, resolve and the
// filtered journal — over a real database, through the express router, with
// the same board/agent actor fixtures the 1.6-GRD route suite uses. Company
// scoping on reads, board-only writes, invalid bodies rejected, and the
// resolve endpoint answering the precedence chain with its source.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  guardrailEvents,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonGuardrailsRoutes } from "./routes.js";
import { recordGuardrailEvent } from "./events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "admin" }],
    permissions: [],
    onBehalfOfUserId: null,
  };
}

function agentActor(companyId: string, agentId: string) {
  return {
    type: "agent",
    source: "agent_key",
    agentId,
    keyId: "key-a",
    runId: null,
    companyId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [],
    permissions: [],
    onBehalfOfUserId: null,
  };
}

function noActor() {
  return { type: "none" };
}

describeEmbeddedPostgres("myrmidon(1.7-GRD-MODES): routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let otherCompanyId = "";
  let agentId = "";
  let app!: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-grd-modes-routes-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({ name: `modes routes ${randomUUID()}`, issuePrefix: `MR${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    const other = await db
      .insert(companies)
      .values({ name: `other ${randomUUID()}`, issuePrefix: `MO${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    otherCompanyId = other.id;
    const agent = await db
      .insert(agents)
      .values({ companyId, name: `eng-${randomUUID().slice(0, 6)}`, adapterType: "claude_code", role: "engineer" })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = boardActor(companyId);
      next();
    });
    app.use("/api", myrmidonGuardrailsRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  /** An app whose every request carries the given actor. */
  function appWithActor(actor: unknown) {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    expressApp.use("/api", myrmidonGuardrailsRoutes(db));
    expressApp.use(errorHandler);
    return expressApp;
  }

  afterEach(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
  });

  afterAll(async () => {
    await db.delete(guardrailEvents);
    await db.delete(activityLog);
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await db.delete(companies).where(eq(companies.id, otherCompanyId));
    await tempDb?.cleanup();
  });

  it("GET settings answers the empty default document", async () => {
    const res = await request(app).get(`/api/myrmidon/companies/${companyId}/guardrails/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ company: {}, castes: {}, agents: {} });
  });

  it("PUT settings stores the document for a board actor and echoes it", async () => {
    const res = await request(app)
      .put(`/api/myrmidon/companies/${companyId}/guardrails/settings`)
      .send({ company: { secret: "mask" }, castes: { engineer: { injection: "block" } }, agents: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: { secret: "mask" } });
    const stored = await request(app).get(`/api/myrmidon/companies/${companyId}/guardrails/settings`);
    expect(stored.body).toEqual(res.body);
    // The mutation is audited.
    const [audit] = await db.select().from(activityLog).limit(1);
    expect(audit?.action).toBe("guardrails.modes_settings_updated");
  });

  it("PUT settings rejects an invalid body", async () => {
    const res = await request(app)
      .put(`/api/myrmidon/companies/${companyId}/guardrails/settings`)
      .send({ company: { secret: "nuclear" } });
    // The generic validate() middleware maps a ZodError to the repo's
    // standard 400 validation response.
    expect(res.status).toBe(400);
  });

  it("PUT settings refuses a non-board actor", async () => {
    const agentApp = appWithActor(agentActor(companyId, agentId));
    const res = await request(agentApp)
      .put(`/api/myrmidon/companies/${companyId}/guardrails/settings`)
      .send({ company: { secret: "block" } });
    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated settings read", async () => {
    const anonApp = appWithActor(noActor());
    const res = await request(anonApp).get(`/api/myrmidon/companies/${companyId}/guardrails/settings`);
    expect(res.status).toBe(401);
  });

  it("resolve answers the effective chain with its source", async () => {
    await request(app)
      .put(`/api/myrmidon/companies/${companyId}/guardrails/settings`)
      .send({
        company: { pii: "mask" },
        castes: { engineer: { secret: "block" } },
        agents: {},
      });
    const res = await request(app).get(
      `/api/myrmidon/companies/${companyId}/guardrails/resolve?agentId=${agentId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.agentRole).toBe("engineer");
    expect(res.body.forced).toBeNull();
    const byRule = new Map(res.body.rules.map((rule: { rule: string }) => [rule.rule, rule]));
    expect(byRule.get("secret")).toMatchObject({ mode: "block", source: "caste", caste: "engineer" });
    expect(byRule.get("pii")).toMatchObject({ mode: "mask", source: "company" });
    expect(byRule.get("injection")).toMatchObject({ mode: "flag", source: "default" });
  });

  it("resolve requires agentId", async () => {
    const res = await request(app).get(`/api/myrmidon/companies/${companyId}/guardrails/resolve`);
    expect(res.status).toBe(400);
  });

  it("events honor the kind and severity filters", async () => {
    await recordGuardrailEvent(db, {
      companyId,
      issueId: null,
      runId: null,
      kind: "secret",
      surface: "run_output",
      severity: "error",
      snippet: "one",
      occurredAt: new Date("2026-01-02T03:04:05.000Z"),
    });
    await recordGuardrailEvent(db, {
      companyId,
      issueId: null,
      runId: null,
      kind: "pii",
      surface: "run_output",
      severity: "info",
      snippet: "two",
      occurredAt: new Date("2026-01-02T03:04:06.000Z"),
    });
    const all = await request(app).get(`/api/myrmidon/companies/${companyId}/guardrails/events`);
    expect(all.body.count).toBe(2);
    const secretOnly = await request(app).get(
      `/api/myrmidon/companies/${companyId}/guardrails/events?kind=secret`,
    );
    expect(secretOnly.body.count).toBe(1);
    expect(secretOnly.body.events[0].kind).toBe("secret");
    const errorsOnly = await request(app).get(
      `/api/myrmidon/companies/${companyId}/guardrails/events?severity=error`,
    );
    expect(errorsOnly.body.count).toBe(1);
    expect(errorsOnly.body.events[0].severity).toBe("error");
    const none = await request(app).get(
      `/api/myrmidon/companies/${companyId}/guardrails/events?kind=secret&severity=info`,
    );
    expect(none.body.count).toBe(0);
  });

  it("events stay company-scoped", async () => {
    await recordGuardrailEvent(db, {
      companyId: otherCompanyId,
      issueId: null,
      runId: null,
      kind: "secret",
      surface: "run_output",
      severity: "warn",
      snippet: "other",
      occurredAt: new Date("2026-01-02T03:04:05.000Z"),
    });
    const res = await request(app).get(`/api/myrmidon/companies/${companyId}/guardrails/events`);
    expect(res.body.count).toBe(0);
  });
});
