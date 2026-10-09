import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  activityLog,
  principalPermissionGrants,
  projects,
  toolAccessAuditEvents,
  toolCallEvents,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
// myrmidon(DB-PERF-C-P4): the fixtures below write profiles, bindings and entries around the
// tool-access CRUD, so they drop the company snapshot the way those CRUD paths do.
import { invalidateToolPolicyCache } from "../myrmidon/tool-policy-cache/runtime.js";
import {
  agentToolPermissionAllows,
  normalizeAgentToolPermissions,
  readAgentToolPermissions,
} from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** A built-in gateway tool that needs no connection, so the only gate under test is the permission. */
const FIXTURE_TOOL = "mcp-remote-fixture:echo";

type Db = ReturnType<typeof createDb>;

describe("myrmidon(S6) agent tool permission model", () => {
  it("treats an absent or malformed permission as allow-all", () => {
    expect(readAgentToolPermissions({})).toEqual({ mode: "all", tools: [], connections: [] });
    expect(readAgentToolPermissions(undefined)).toEqual({ mode: "all", tools: [], connections: [] });
    expect(readAgentToolPermissions({ toolAccess: { mode: "listed" } })).toEqual({
      mode: "listed",
      tools: [],
      connections: [],
    });
    expect(readAgentToolPermissions({ toolAccess: "nonsense" })).toEqual({
      mode: "all",
      tools: [],
      connections: [],
    });
    expect(
      normalizeAgentToolPermissions({ mode: "listed", tools: [" a ", "a", 5], connections: null }),
    ).toEqual({ mode: "listed", tools: ["a"], connections: [] });
  });

  it("allows everything in the all mode and only named tools in the listed mode", () => {
    expect(agentToolPermissionAllows({ mode: "all", tools: [], connections: [] }, { toolName: "x" })).toBe(true);
    const listed = { mode: "listed" as const, tools: ["x"], connections: ["c1"] };
    expect(agentToolPermissionAllows(listed, { toolName: "x" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "y", connectionId: "c1" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "y", catalogEntryId: "x" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "y", connectionId: "c2" })).toBe(false);
    expect(agentToolPermissionAllows(listed, { toolName: "y" })).toBe(false);
  });
});

describeEmbeddedPostgres("myrmidon(S6) agent tool permission enforcement", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-tool-permissions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    return db
      .insert(companies)
      .values({
        name: `Tool permission ${randomUUID()}`,
        issuePrefix: `ATP${randomUUID().slice(0, 5).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createAgent(companyId: string, permissions: Record<string, unknown>) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** A running run: the session of a bot or a host run is bound to it (A2). */
  async function createRunningRun(companyId: string, agentId: string) {
    const project = await db
      .insert(projects)
      .values({ companyId, name: `Project ${randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        title: `Issue ${randomUUID()}`,
        status: "in_progress",
        assigneeAgentId: agentId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: { issueId: issue.id, projectId: project.id },
      })
      .returning()
      .then((rows) => rows[0]!);
    return { project, issue, run };
  }

  /** An allow-all profile, so the only thing that can deny the call is the agent permission. */
  async function allowAllToolsForAgent(companyId: string, agentId: string) {
    const profile = await db
      .insert(toolProfiles)
      .values({
        companyId,
        profileKey: `permission-all-${randomUUID()}`,
        name: `All ${randomUUID()}`,
        defaultAction: "allow",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .insert(toolProfileBindings)
      .values({ companyId, profileId: profile.id, targetType: "agent", targetId: agentId });
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: profile.id,
      selectorType: "tool_name" as const,
      effect: "include" as const,
      toolName: FIXTURE_TOOL,
    });
    // myrmidon(DB-PERF-C-P4): the fixture writes around the tool-access CRUD.
    invalidateToolPolicyCache(db, companyId);
    return profile;
  }

  function createGateway() {
    return createToolGatewayService(db, { toolActionSigningSecret: "test-tool-action-signing-secret" });
  }

  it("refuses a tool the agent's list does not name, and writes it to the journal", async () => {
    const company = await createCompany();
    const agent = await createAgent(company.id, { toolAccess: { mode: "listed", tools: [], connections: [] } });
    const { run } = await createRunningRun(company.id, agent.id);
    await allowAllToolsForAgent(company.id, agent.id);
    const gateway = createGateway();
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    expect(session.runId).toBe(run.id);

    await expect(gateway.listToolsForSession(session.token)).resolves.toEqual([]);

    await gateway
      .executeTool({ sessionToken: session.token, tool: FIXTURE_TOOL, parameters: { message: "denied" } })
      .then(
        () => {
          throw new Error("Expected the tool call to be refused");
        },
        (error) => {
          expect(error).toBeInstanceOf(ToolGatewayHttpError);
          expect((error as ToolGatewayHttpError).status).toBe(403);
          expect((error as ToolGatewayHttpError).reasonCode).toBe("deny_agent_permission");
        },
      );

    const denials = await db
      .select()
      .from(toolCallEvents)
      .where(eq(toolCallEvents.reasonCode, "deny_agent_permission"));
    expect(denials.map((row) => row.agentId)).toContain(agent.id);
    expect(denials.map((row) => row.decision)).toContain("deny");
    expect(denials.map((row) => row.runId)).toContain(run.id);
  });

  it("lets a named tool through and leaves an agent without the permission unchanged", async () => {
    const company = await createCompany();
    const gateway = createGateway();

    const listedAgent = await createAgent(company.id, { toolAccess: { mode: "listed", tools: [FIXTURE_TOOL] } });
    const listedRun = await createRunningRun(company.id, listedAgent.id);
    await allowAllToolsForAgent(company.id, listedAgent.id);
    const listedSession = await gateway.createSession({
      companyId: company.id,
      agentId: listedAgent.id,
      runId: listedRun.run.id,
    });
    await expect(
      gateway.executeTool({ sessionToken: listedSession.token, tool: FIXTURE_TOOL, parameters: { message: "allowed" } }),
    ).resolves.toMatchObject({ tool: FIXTURE_TOOL });

    const unsetAgent = await createAgent(company.id, {});
    const unsetRun = await createRunningRun(company.id, unsetAgent.id);
    await allowAllToolsForAgent(company.id, unsetAgent.id);
    const unsetSession = await gateway.createSession({
      companyId: company.id,
      agentId: unsetAgent.id,
      runId: unsetRun.run.id,
    });
    await expect(
      gateway.executeTool({ sessionToken: unsetSession.token, tool: FIXTURE_TOOL, parameters: { message: "unchanged" } }),
    ).resolves.toMatchObject({ tool: FIXTURE_TOOL });
  });

  // myrmidon(1.6.5-F22): actor × grant → status matrix for the tools
  // gallery / connections surfaces. Board actors keep their behavior; an agent
  // is admitted by an explicit company grant (tools:admin /
  // tools:manage_connections reads, tools:manage_connections mutations, DELETE
  // stays operator-only in the minimal variant).
  describe("myrmidon(F-22) gallery/connections grant access matrix", () => {
    type RouteActor = Express.Request["actor"];

    function createGrantRouteApp(db: Db, actor: RouteActor) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      app.use(
        "/api",
        toolAccessRoutes(db, {
          remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
          remoteHttpRequest: async (url: string, init: RequestInit) => fetch(url, init),
        }),
      );
      app.use(errorHandler);
      return app;
    }

    const boardActor: RouteActor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    };

    function agentActor(companyId: string, agentId: string, runId: string): RouteActor {
      return { type: "agent", companyId, agentId, runId, source: "agent_jwt" };
    }

    async function grantAgentPermission(
      db: Db,
      companyId: string,
      agentId: string,
      permissionKeys: PermissionKey[],
    ) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      }).onConflictDoNothing();
      if (permissionKeys.length === 0) return;
      await db.insert(principalPermissionGrants).values(
        permissionKeys.map((permissionKey) => ({
          companyId,
          principalType: "agent",
          principalId: agentId,
          permissionKey,
          scope: null,
          grantedByUserId: null,
        })),
      );
    }

    async function agentFixture(
      company: { id: string },
      permissionKeys: PermissionKey[] = [],
    ) {
      const agent = await createAgent(company.id, {});
      const { run } = await createRunningRun(company.id, agent.id);
      await grantAgentPermission(db, company.id, agent.id, permissionKeys);
      return { agent, run };
    }

    async function createConnectionViaBoard(db: Db, company: { id: string }) {
      const app = createGrantRouteApp(db, boardActor);
      const res = await request(app)
        .post(`/api/companies/${company.id}/tools/connections`)
        .send({
          name: `F22 connection ${randomUUID()}`,
          transport: "mcp_remote",
          config: { url: `https://f22-${randomUUID().slice(0, 8)}.example/mcp` },
          status: "active",
          enabled: true,
        });
      expect(res.status).toBe(201);
      return res.body as { id: string };
    }

    async function auditRows(db: Db, companyId: string) {
      return db
        .select()
        .from(toolAccessAuditEvents)
        .where(eq(toolAccessAuditEvents.companyId, companyId));
    }

    it("board actor still reads the gallery (200) and the gallery is not company-leaky", async () => {
      const company = await createCompany();
      const res = await request(createGrantRouteApp(db, boardActor))
        .get(`/api/companies/${company.id}/tools/gallery`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.apps)).toBe(true);
    });

    it("agent with tools:admin reads gallery (200) and the read is audited as an agent row", async () => {
      const company = await createCompany();
      const { agent, run } = await agentFixture(company, ["tools:admin"]);
      const res = await request(createGrantRouteApp(db, agentActor(company.id, agent.id, run.id)))
        .get(`/api/companies/${company.id}/tools/gallery`);
      expect(res.status).toBe(200);
      const rows = await auditRows(db, company.id);
      expect(rows.some((row) =>
        row.actorType === "agent"
        && row.actorId === agent.id
        && row.action === "tool_access.gallery.read"
        && row.outcome === "success")).toBe(true);
    });

    it("agent with tools:manage_connections reads gallery (200) and the connections list (200)", async () => {
      const company = await createCompany();
      const { agent, run } = await agentFixture(company, ["tools:manage_connections"]);
      const app = createGrantRouteApp(db, agentActor(company.id, agent.id, run.id));
      const gallery = await request(app).get(`/api/companies/${company.id}/tools/gallery`);
      expect(gallery.status).toBe(200);
      const list = await request(app).get(`/api/companies/${company.id}/tools/connections`);
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.connections)).toBe(true);
    });

    it("agent without grants is denied gallery, connections list and by-id reads with 403", async () => {
      const company = await createCompany();
      const { agent, run } = await agentFixture(company);
      const app = createGrantRouteApp(db, agentActor(company.id, agent.id, run.id));
      expect((await request(app).get(`/api/companies/${company.id}/tools/gallery`)).status).toBe(403);
      expect((await request(app).get(`/api/companies/${company.id}/tools/connections`)).status).toBe(403);
      const connection = await createConnectionViaBoard(db, company);
      const byId = await request(app).get(`/api/tool-connections/${connection.id}`);
      expect(byId.status).toBe(403);
    });

    it("agent with tools:manage_connections creates a connection (201), audited with actorType agent", async () => {
      const company = await createCompany();
      const { agent, run } = await agentFixture(company, ["tools:manage_connections"]);
      const res = await request(createGrantRouteApp(db, agentActor(company.id, agent.id, run.id)))
        .post(`/api/companies/${company.id}/tools/connections`)
        .send({
          name: `F22 agent connection ${randomUUID()}`,
          transport: "mcp_remote",
          config: { url: `https://f22-agent-${randomUUID().slice(0, 8)}.example/mcp` },
        });
      expect(res.status).toBe(201);
      const rows = await auditRows(db, company.id);
      expect(rows.some((row) =>
        row.actorType === "agent"
        && row.action === "tool_access.connections.create"
        && row.outcome === "success"
        && row.connectionId === res.body.id)).toBe(true);
    });

    it("agent without grants is denied POST /tools/connections with 403", async () => {
      const company = await createCompany();
      const { agent, run } = await agentFixture(company);
      const res = await request(createGrantRouteApp(db, agentActor(company.id, agent.id, run.id)))
        .post(`/api/companies/${company.id}/tools/connections`)
        .send({
          name: `F22 denied connection ${randomUUID()}`,
          transport: "mcp_remote",
          config: { url: "https://f22-denied.example/mcp" },
        });
      expect(res.status).toBe(403);
    });

    it("agent with tools:admin reads a connection by id (200) with an agent audit row", async () => {
      const company = await createCompany();
      const connection = await createConnectionViaBoard(db, company);
      const { agent, run } = await agentFixture(company, ["tools:admin"]);
      const res = await request(createGrantRouteApp(db, agentActor(company.id, agent.id, run.id)))
        .get(`/api/tool-connections/${connection.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(connection.id);
      const rows = await auditRows(db, company.id);
      expect(rows.some((row) =>
        row.actorType === "agent"
        && row.action === "tool_access.connection.read"
        && row.connectionId === connection.id)).toBe(true);
    });

    it("agent with tools:manage_connections updates (PATCH) and syncs installs (PUT)", async () => {
      const company = await createCompany();
      const connection = await createConnectionViaBoard(db, company);
      const { agent, run } = await agentFixture(company, ["tools:manage_connections"]);
      const app = createGrantRouteApp(db, agentActor(company.id, agent.id, run.id));
      const patch = await request(app)
        .patch(`/api/tool-connections/${connection.id}`)
        .send({ name: `F22 renamed ${randomUUID().slice(0, 8)}` });
      expect(patch.status).toBe(200);
      const put = await request(app)
        .put(`/api/tool-connections/${connection.id}/installs`)
        .send({ installs: [{ targetType: "company", targetId: company.id }] });
      expect(put.status).toBe(200);
      const rows = await auditRows(db, company.id);
      expect(rows.some((row) => row.actorType === "agent" && row.action === "tool_access.connection.update")).toBe(true);
      expect(rows.some((row) => row.actorType === "agent" && row.action === "tool_access.connection.installs_sync")).toBe(true);
    });

    it("agent with tools:manage_connections is denied DELETE with 403 (minimal variant) and the denial is audited", async () => {
      const company = await createCompany();
      const connection = await createConnectionViaBoard(db, company);
      const { agent, run } = await agentFixture(company, ["tools:manage_connections"]);
      const res = await request(createGrantRouteApp(db, agentActor(company.id, agent.id, run.id)))
        .delete(`/api/tool-connections/${connection.id}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("operator confirmation");
      const after = await request(createGrantRouteApp(db, boardActor))
        .get(`/api/tool-connections/${connection.id}`);
      expect(after.status).toBe(200);
      const rows = await auditRows(db, company.id);
      expect(rows.some((row) =>
        row.actorType === "agent"
        && row.action === "tool_access.connection.delete"
        && row.outcome === "denied"
        && row.reasonCode === "deny_agent_requires_operator_confirmation")).toBe(true);
    });

    it("agent without grants is denied PATCH/PUT/DELETE on a connection with 403", async () => {
      const company = await createCompany();
      const connection = await createConnectionViaBoard(db, company);
      const { agent, run } = await agentFixture(company);
      const app = createGrantRouteApp(db, agentActor(company.id, agent.id, run.id));
      expect((await request(app).patch(`/api/tool-connections/${connection.id}`).send({ name: "nope" })).status).toBe(403);
      expect((await request(app)
        .put(`/api/tool-connections/${connection.id}/installs`)
        .send({ installs: [{ targetType: "company", targetId: company.id }] })).status).toBe(403);
      expect((await request(app).delete(`/api/tool-connections/${connection.id}`)).status).toBe(403);
    });

    it("agent connection mutations still land in the activity log with actorType agent", async () => {
      const company = await createCompany();
      const { agent, run } = await agentFixture(company, ["tools:manage_connections"]);
      const res = await request(createGrantRouteApp(db, agentActor(company.id, agent.id, run.id)))
        .post(`/api/companies/${company.id}/tools/connections`)
        .send({
          name: `F22 activity connection ${randomUUID()}`,
          transport: "mcp_remote",
          config: { url: `https://f22-activity-${randomUUID().slice(0, 8)}.example/mcp` },
        });
      expect(res.status).toBe(201);
      const rows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, company.id));
      const created = rows.find((row) => row.action === "tool_connection.created");
      expect(created).toBeTruthy();
      expect(created!.actorType).toBe("agent");
      expect(created!.agentId).toBe(agent.id);
    });
  });
});