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
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  issueRoutes,
} from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// myrmidon(AGENT-ISSUE-LIST): for agent actors GET /api/companies/:companyId/issues
// defaults to the compact projection, limit 50, and omits `description` unless
// explicitly requested (?includeDescription=true or view=full is the explicit
// projection request; description still only returns on explicit opt-in).
// Board actors keep the vendor behaviour untouched.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// A column the vendor full serializer always carries and the compact
// projection always drops — the stable way to tell the two shapes apart.
const FULL_ONLY_FIELD = "conversationAgentId";

describeEmbeddedPostgres("issue list agent compact defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-agent-compact-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  function createApp(companyId: string, actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(input: { issueCount: number; descriptionChars: number }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const userId = `user-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Compact defaults agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueIds: string[] = [];
    for (let index = 0; index < input.issueCount; index += 1) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Issue ${index}`,
        description: index % 2 === 0 ? "d".repeat(input.descriptionChars) : null,
        status: "todo",
        priority: "medium",
      });
    }

    const agentApp = createApp(companyId, {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_key",
    });
    const boardApp = createApp(companyId, {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [
        {
          companyId,
          membershipRole: "owner",
          status: "active",
          principalId: userId,
        },
      ],
      source: "cloud_tenant",
      isInstanceAdmin: false,
    });
    return { companyId, agentId, runId, userId, issueIds, agentApp, boardApp };
  }

  it("agent default: compact projection, max 50 rows, no description, small body", async () => {
    const seeded = await seedCompany({ issueCount: 60, descriptionChars: 4000 });

    const res = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .expect(200);

    const rows = res.body as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(50);
    for (const row of rows) {
      expect(row).not.toHaveProperty(FULL_ONLY_FIELD);
      expect(row).not.toHaveProperty("description");
    }
    // acceptance measure: agent default response on the 60x4000-char seed
    const bodyBytes = Buffer.byteLength(JSON.stringify(res.body), "utf8");
    expect(bodyBytes).toBeLessThanOrEqual(500 * 1024);

    // same seed, board default request: unchanged vendor shape, descriptions in
    const boardRes = await request(seeded.boardApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .expect(200);
    const boardRows = boardRes.body as Array<Record<string, unknown>>;
    expect(boardRows.length).toBe(60);
    expect(
      boardRows.filter((row) => typeof row.description === "string").length,
    ).toBeGreaterThan(0);
  });

  it("agent explicit limit respected within clampIssueListLimit", async () => {
    const seeded = await seedCompany({ issueCount: 60, descriptionChars: 10 });

    const res = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ limit: "55" })
      .expect(200);
    expect((res.body as unknown[]).length).toBe(55);

    const resSmall = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ limit: "1" })
      .expect(200);
    expect((resSmall.body as unknown[]).length).toBe(1);
  });

  it("agent includeDescription=true returns description; invalid value is 400", async () => {
    const seeded = await seedCompany({ issueCount: 3, descriptionChars: 64 });

    const res = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ includeDescription: "true" })
      .expect(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    // still the compact projection
    expect(rows[0]).not.toHaveProperty(FULL_ONLY_FIELD);
    // but now with descriptions on the seeded rows
    expect(rows.filter((row) => typeof row.description === "string").length).toBeGreaterThan(0);

    await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ includeDescription: "maybe" })
      .expect(400);
  });

  it("agent explicit view=compact and view=full keep working", async () => {
    const seeded = await seedCompany({ issueCount: 2, descriptionChars: 64 });

    const compact = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "compact" })
      .expect(200);
    expect(compact.body[0]).not.toHaveProperty(FULL_ONLY_FIELD);
    // for agents `description` returns only on an explicit request, so
    // ?view=compact without ?includeDescription=true keeps trimming it
    expect(compact.body[0]).not.toHaveProperty("description");

    const compactWithDesc = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "compact", includeDescription: "true" })
      .expect(200);
    expect(
      compactWithDesc.body.filter((row: Record<string, unknown>) =>
        typeof row.description === "string",
      ).length,
    ).toBeGreaterThan(0);

    const full = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "full" })
      .expect(200);
    expect(full.body[0]).toHaveProperty(FULL_ONLY_FIELD);
    // per the ticket intro: description returns on explicit ?includeDescription=true
    // or view=full
    expect(
      full.body.filter((row: Record<string, unknown>) =>
        Object.prototype.hasOwnProperty.call(row, "description"),
      ).length,
    ).toBe(full.body.length);

    const fullNoDesc = await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "full", includeDescription: "false" })
      .expect(200);
    expect(fullNoDesc.body[0]).toHaveProperty(FULL_ONLY_FIELD);
    expect(fullNoDesc.body[0]).not.toHaveProperty("description");

    await request(seeded.agentApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "board" })
      .expect(400);
  });

  it("board actor default keeps the vendor full list with description (no regression)", async () => {
    const seeded = await seedCompany({ issueCount: 3, descriptionChars: 64 });

    const res = await request(seeded.boardApp)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .expect(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(rows[0]).toHaveProperty(FULL_ONLY_FIELD);
    expect(typeof rows[0].description).toBe("string");
  });
});
