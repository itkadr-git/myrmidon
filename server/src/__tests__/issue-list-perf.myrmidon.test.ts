import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, issues } from "@myrmidon/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue list route performance (OPE-9997)", () => {
  const ctx = useEmbeddedPostgres();

  beforeEach(async () => {
    await resetCompanyIssueFixtures(ctx.db);
  });

  async function seed200Issues(companyId: string) {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      title: `Issue ${index} with realistic title length`,
      description: `Detailed description for issue ${index} with multiple sentences simulating real board payloads.`,
      status: index % 2 === 0 ? "in_progress" : "todo",
      priority: index % 3 === 0 ? "high" : "medium",
    }));
    await ctx.db.insert(issues).values(rows);
    return rows;
  }

  async function createAgentActor(companyId: string) {
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "perf-agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return {
      type: "agent" as const,
      source: "agent_jwt",
      agentId,
      companyId,
      runId: null,
      isInstanceAdmin: false,
    };
  }

  it("proves complete GET /api/companies/:id/issues route responds in < 500 ms for 200 compact rows", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Perf Company");
    const { companyId } = company;
    await seed200Issues(companyId);

    const actor = await createAgentActor(companyId);
    const app = routeApp(ctx.db, actor as never, issueRoutes);

    // Warm-up call
    await request(app).get(`/api/companies/${companyId}/issues`).expect(200);

    const t0 = performance.now();
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    const elapsedMs = performance.now() - t0;

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(200);
    expect(res.headers.etag).toMatch(/^"compact-issues:/);
    // Compact rows do not include large description payloads
    for (const row of res.body) {
      expect(row).not.toHaveProperty("description");
    }
    // Behavioral acceptance: route completes full query, projection, and serialization < 500 ms
    expect(elapsedMs).toBeLessThan(500);
  });

  it("proves integration board keys (source: board_key) also receive 200 compact rows in < 500 ms", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Perf BoardKey Company");
    const { companyId } = company;
    await seed200Issues(companyId);

    const boardKeyActor = {
      ...company.actor,
      source: "board_key" as const,
      keyId: randomUUID(),
    };
    const app = routeApp(ctx.db, boardKeyActor as never, issueRoutes);

    // Warm-up call
    await request(app).get(`/api/companies/${companyId}/issues`).expect(200);

    const t0 = performance.now();
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    const elapsedMs = performance.now() - t0;

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(200);
    expect(res.headers.etag).toMatch(/^"compact-issues:/);
    for (const row of res.body) {
      expect(row).not.toHaveProperty("description");
    }
    expect(elapsedMs).toBeLessThan(500);
  });
});
