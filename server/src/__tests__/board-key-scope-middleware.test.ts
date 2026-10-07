import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { boardKeyScopeMiddleware } from "../middleware/board-key-scope.js";

function appFor(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  // Mounted at the app root exactly like app.ts does — req.path starts
  // with /api here, which is the production wiring the scope check must
  // survive (review round 1 caught the prefix-strip bug this guards).
  app.use(boardKeyScopeMiddleware());
  app.use("/api", (req, res) => {
    res.json({ ok: true, path: req.path, method: req.method });
  });
  // minimal error shape mirroring the app's errorHandler contract
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

const boardKeyActor = (scope: any) => ({
  type: "board",
  userId: "user-1",
  source: "board_key",
  keyId: "key-1",
  boardKeyScope: scope,
});

// A real company id is a GUID (the scope schema validates it as one), so the
// link cases use one; the paths carry the same id because a link key's scope
// company and the company it acts in must agree (authz enforces the match,
// pinned in board-key-tenant-confinement.test.ts).
const LINK_COMPANY = "11111111-1111-4111-8111-111111111111";

describe("boardKeyScopeMiddleware (myrmidon ROLE-SCOPED-TOKENS)", () => {
  it("lets non-board-key actors through untouched", async () => {
    const app = appFor({ type: "board", userId: "user-1", source: "session" });
    const res = await request(app).post("/api/companies/1/agents");
    expect(res.status).toBe(200);
  });

  it("lets agent actors through untouched", async () => {
    const app = appFor({ type: "agent", agentId: "a-1", source: "agent_key" });
    const res = await request(app).post("/api/issues");
    expect(res.status).toBe(200);
  });

  it("full-scope and scopeless board keys mutate freely", async () => {
    for (const scope of [undefined, { kind: "full" }]) {
      const app = appFor(boardKeyActor(scope));
      const res = await request(app).delete("/api/companies/1/agents/9");
      expect(res.status).toBe(200);
    }
  });

  it("read_only board key: GET passes, POST is rejected 403 with scope reason", async () => {
    const app = appFor(boardKeyActor({ kind: "read_only" }));
    const get = await request(app).get("/api/companies/1/issues");
    expect(get.status).toBe(200);
    const post = await request(app).post("/api/companies/1/issues");
    expect(post.status).toBe(403);
    expect(post.body.error).toContain("read_only");
  });

  it("secrets_manage board key can rotate a secret but cannot create agents", async () => {
    const app = appFor(boardKeyActor({ kind: "secrets_manage" }));
    const rotate = await request(app).post("/api/secrets/1/rotate");
    expect(rotate.status).toBe(200);
    const createAgent = await request(app).post("/api/companies/1/agents");
    expect(createAgent.status).toBe(403);
  });

  it("agents_manage board key can wake agents but cannot touch secrets", async () => {
    const app = appFor(boardKeyActor({ kind: "agents_manage" }));
    const wake = await request(app).post("/api/companies/1/agents/9/wake");
    expect(wake.status).toBe(200);
    const rot = await request(app).post("/api/secrets/1/rotate");
    expect(rot.status).toBe(403);
  });

  it("release board key can mutate issues but not agents", async () => {
    const app = appFor(boardKeyActor({ kind: "release" }));
    const mutate = await request(app).patch("/api/companies/1/issues/5");
    expect(mutate.status).toBe(200);
    const agent = await request(app).post("/api/companies/1/agents");
    expect(agent.status).toBe(403);
  });

  it("ops board key can enter maintenance but cannot mutate issues or plugins", async () => {
    const app = appFor(boardKeyActor({ kind: "ops" }));
    const maint = await request(app).post("/api/health/maintenance");
    expect(maint.status).toBe(200);
    const issue = await request(app).post("/api/companies/1/issues");
    expect(issue.status).toBe(403);
    // Plugin install/upgrade/config is code execution — full-only (review).
    const install = await request(app).post("/api/plugins/install");
    expect(install.status).toBe(403);
    const upgrade = await request(app).post("/api/plugins/some-id/upgrade");
    expect(upgrade.status).toBe(403);
  });

  it("agents_manage board key cannot mint invites or claim the board", async () => {
    const app = appFor(boardKeyActor({ kind: "agents_manage" }));
    const invite = await request(app).post("/api/companies/1/invites");
    expect(invite.status).toBe(403);
    const claim = await request(app).post("/api/board-claim/token-x/claim");
    expect(claim.status).toBe(403);
  });

  // myrmidon(1.6.6 MONITORING E): a linking component's key is the narrowest
  // board key there is. It may file and update a task and say "I am alive";
  // everything an operator key could do stays out of reach.
  it("monitoring_link key can file a task, update it and pulse", async () => {
    const app = appFor(boardKeyActor({ kind: "monitoring_link", linkKey: "zabbix-aggregator", companyId: LINK_COMPANY }));
    const create = await request(app).post(`/api/companies/${LINK_COMPANY}/issues`);
    expect(create.status).toBe(200);
    const update = await request(app).patch("/api/issues/5");
    expect(update.status).toBe(200);
    const pulse = await request(app).post(`/api/myrmidon/companies/${LINK_COMPANY}/monitoring/links/pulse`);
    expect(pulse.status).toBe(200);
  });

  it("monitoring_link key cannot reach the operator surface", async () => {
    const app = appFor(
      boardKeyActor({ kind: "monitoring_link", linkKey: "zabbix-aggregator", companyId: LINK_COMPANY }),
    );
    const agent = await request(app).post("/api/companies/1/agents");
    expect(agent.status).toBe(403);
    const secret = await request(app).post("/api/secrets/1/rotate");
    expect(secret.status).toBe(403);
    const invite = await request(app).post("/api/companies/1/invites");
    expect(invite.status).toBe(403);
    const maintenance = await request(app).post("/api/health/maintenance");
    expect(maintenance.status).toBe(403);
    const plugin = await request(app).post("/api/plugins/install");
    expect(plugin.status).toBe(403);
    // Even on its own subject: a link files tasks, it does not delete them.
    const remove = await request(app).delete("/api/issues/5");
    expect(remove.status).toBe(403);
  });

  it("monitoring_link key reads stay on the liveness surface", async () => {
    const app = appFor(boardKeyActor({ kind: "monitoring_link", linkKey: "alertmanager-webhook", companyId: LINK_COMPANY }));
    const links = await request(app).get(`/api/myrmidon/companies/${LINK_COMPANY}/monitoring/links`);
    expect(links.status).toBe(200);
    const issues = await request(app).get(`/api/companies/${LINK_COMPANY}/issues`);
    expect(issues.status).toBe(200);
    // Company, agent and secret listings are operator knowledge, not link
    // knowledge: a leaked link key must not become a reconnaissance tool.
    const companies = await request(app).get("/api/companies");
    expect(companies.status).toBe(403);
    const agents = await request(app).get("/api/companies/1/agents");
    expect(agents.status).toBe(403);
    const secrets = await request(app).get("/api/secrets");
    expect(secrets.status).toBe(403);
  });

  it("a link key with a malformed stored scope degrades to read_only, not full", async () => {
    // The store hands back whatever JSON is in the column; a link scope that
    // lost its linkKey must not be readable as an operator key.
    const app = appFor(boardKeyActor({ kind: "monitoring_link" }));
    const create = await request(app).post("/api/companies/1/issues");
    expect(create.status).toBe(403);
    const read = await request(app).get("/api/companies/1/issues");
    expect(read.status).toBe(200);
  });
});
