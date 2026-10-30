import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, issues, issueThreadInteractions } from "@myrmidon/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue-thread-interaction routes acceptance (OPE-9150)", () => {
  const ctx = useEmbeddedPostgres("interaction-route-acceptance-", {
    resetEach: async (db) => {
      await db.delete(issueThreadInteractions);
      await db.delete(activityLog);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed() {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Interaction route acceptance");
    const companyId = seeded.companyId;
    const issueId = randomUUID();

    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interaction test issue",
      status: "in_progress",
      priority: "medium",
    });

    return { ...seeded, issueId };
  }

  function appFor(seeded: Awaited<ReturnType<typeof seed>>) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  it("rejects interaction creation without addressee via HTTP route with 422 and writes no row to DB", async () => {
    const seeded = await seed();

    const res = await request(appFor(seeded))
      .post(`/api/issues/${seeded.issueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: { version: 1, prompt: "Confirm without addressee" },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Cannot determine recipient for interaction");

    const rows = await ctx.db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, seeded.issueId));
    expect(rows).toHaveLength(0);
  });

  it("creates interaction with explicit agent addressee via HTTP route and persists route_type and timeout_at in DB", async () => {
    const seeded = await seed();
    const targetAgentId = randomUUID();

    await ctx.db.insert(agents).values({
      id: targetAgentId,
      companyId: seeded.companyId,
      name: "Target Agent",
      role: "engineer",
      status: "active",
    });

    const res = await request(appFor(seeded))
      .post(`/api/issues/${seeded.issueId}/interactions`)
      .send({
        kind: "request_confirmation",
        addresseeAgentId: targetAgentId,
        payload: { version: 1, prompt: "Please approve" },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.addresseeAgentId).toBe(targetAgentId);
    expect(res.body.routeType).toBe("decision");
    expect(res.body.timeoutAt).toBeDefined();
    expect(typeof res.body.timeoutAt).toBe("string");

    const [dbRow] = await ctx.db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, res.body.id));
    expect(dbRow).toBeDefined();
    expect(dbRow.addresseeAgentId).toBe(targetAgentId);
    expect(dbRow.routeType).toBe("decision");
    expect(dbRow.timeoutAt).toBeDefined();
  });

  it("creates interaction with explicit user addressee via HTTP route and persists route_type and timeout_at in DB", async () => {
    const seeded = await seed();

    const res = await request(appFor(seeded))
      .post(`/api/issues/${seeded.issueId}/interactions`)
      .send({
        kind: "request_confirmation",
        addresseeUserId: seeded.userId,
        payload: { version: 1, prompt: "Please review" },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.addresseeUserId).toBe(seeded.userId);
    expect(res.body.routeType).toBe("human_input");
    expect(res.body.timeoutAt).toBeDefined();
    expect(typeof res.body.timeoutAt).toBe("string");

    const [dbRow] = await ctx.db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, res.body.id));
    expect(dbRow).toBeDefined();
    expect(dbRow.addresseeUserId).toBe(seeded.userId);
    expect(dbRow.routeType).toBe("human_input");
    expect(dbRow.timeoutAt).toBeDefined();
  });
});
