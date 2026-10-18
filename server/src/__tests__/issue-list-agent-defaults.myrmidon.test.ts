import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { instanceSettings, agents } from "@paperclipai/db";
import {
  __clearIssueListResponseCacheForTests,
  issueRoutes,
} from "../routes/issues.js";
import { issues } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * myrmidon(F16): the issue-list agent defaults of
 * `GET /api/companies/:companyId/issues` behind the instance setting
 * `issuesListAgentDefaults` (absent = on). With the fix on, an agent actor
 * without `view` gets the compact view, `limit` defaults to 200 and may be at
 * most 500, and the compact body omits `description`; the full view needs an
 * explicit `view=full&limit<=100`. The board actor and the `enabled: false`
 * state keep the pre-feature behaviour byte-for-byte.
 *
 * Red-side proof: on the base without the F16 change every case that asserts
 * the agent-default behaviour fails (a bare agent request is answered as the
 * full view, `limit=1000` is clamped instead of 400, `view=full` is always
 * 400).
 */

const ISSUE_LIST_AGENT_DEFAULT_LIMIT = 200;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetF16Fixtures(db: Parameters<typeof resetCompanyIssueFixtures>[0]) {
  // myrmidon(F16): the fixture agents seeded by `agentActor` reference the
  // seeded companies, so they are cleared before the harness reset drops
  // companies (FK `agents_company_id_companies_id_fk`).
  await db.delete(agents);
  await resetCompanyIssueFixtures(db);
}

describeEmbeddedPostgres("issue list agent defaults", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-list-agent-defaults-", {
    resetEach: resetF16Fixtures,
  });

  afterEach(() => {
    __clearIssueListResponseCacheForTests();
  });

  async function agentActor(companyId: string) {
    // myrmidon(F16): the authorization layer resolves the acting agent row,
    // so the fixture agent must exist in the company it queries.
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
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

  async function seedCompanyWithIssues(count: number) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Agent defaults");
    const companyId = company.companyId;
    const rows = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      companyId,
      title: `Issue ${index}`,
      description: `Body of issue ${index} with enough text to notice.`,
      status: "todo",
      priority: "medium",
    }));
    await ctx.db.insert(issues).values(rows);
    return { companyId, rows };
  }

  async function setAgentDefaultsEnabled(enabled: boolean | null) {
    const svc = instanceSettingsService(ctx.db);
    if (enabled === null) {
      await ctx.db
        .update(instanceSettings)
        .set({ general: {} })
        .where(eq(instanceSettings.singletonKey, "default"));
      return;
    }
    await svc.updateGeneral({ issuesListAgentDefaults: { enabled } } as never);
  }

  it("answers a bare agent request as the compact view with the agent default limit and no description", async () => {
    const { companyId } = await seedCompanyWithIssues(ISSUE_LIST_AGENT_DEFAULT_LIMIT + 5);
    const res = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(ISSUE_LIST_AGENT_DEFAULT_LIMIT);
    expect(res.headers.etag).toMatch(/^"compact-issues:/);
    for (const row of res.body) {
      expect(row, `description present on ${row.id}`).not.toHaveProperty("description");
    }
  });

  it("rejects an agent limit above the agent maximum with the pagination hint", async () => {
    const { companyId } = await seedCompanyWithIssues(1);
    const res = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?limit=1000`)
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/paginate/i);
    expect(JSON.stringify(res.body)).toContain("500");
  });

  it("answers an agent view=full with an explicit small limit including description", async () => {
    const { companyId } = await seedCompanyWithIssues(3);
    const res = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=full&limit=50`)
      .expect(200);
    expect(res.body).toHaveLength(3);
    for (const row of res.body) {
      expect(row, `description missing on ${row.id}`).toHaveProperty("description");
    }
    expect(res.headers.etag ?? "").not.toMatch(/^"compact-issues:/);
  });

  it("rejects an agent view=full whose limit exceeds the full-view cap", async () => {
    const { companyId } = await seedCompanyWithIssues(1);
    const res = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=full&limit=200`)
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/view=full/);
  });

  it("rejects an agent view=full without an explicit limit", async () => {
    const { companyId } = await seedCompanyWithIssues(1);
    const res = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=full`)
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/limit/);
  });

  it("keeps the pre-feature agent behaviour byte-for-byte when the setting is off", async () => {
    const { companyId } = await seedCompanyWithIssues(2);
    await setAgentDefaultsEnabled(false);
    // Pre-feature the bare agent request stays the full view (a plain weak
    // Express ETag, not the compact-list one) with description on each row.
    const bare = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    expect(bare.headers.etag ?? "").not.toMatch(/^"compact-issues:/);
    expect(bare.body[0]).toHaveProperty("description");
    // The legacy limit message (up to 1000) and the clamp stay in place.
    const clamped = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?limit=1000`)
      .expect(200);
    expect(clamped.body).toHaveLength(2);
    // view=full stays invalid for agents, like before.
    await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=full`)
      .expect(400);
    // The compact view keeps the description when the setting is off.
    const compact = await request(routeApp(ctx.db, await agentActor(companyId) as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=compact&limit=50`)
      .expect(200);
    expect(compact.body[0]).toHaveProperty("description");
  });

  it("leaves the board actor untouched", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Agent defaults board");
    const companyId = company.companyId;
    await ctx.db.insert(issues).values([
      { id: randomUUID(), companyId, title: "Board one", description: "body", status: "todo", priority: "medium" },
      { id: randomUUID(), companyId, title: "Board two", description: "body", status: "todo", priority: "medium" },
    ]);
    // A bare board request stays the full view with descriptions.
    const bare = await request(routeApp(ctx.db, company.actor as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    expect(bare.headers.etag ?? "").not.toMatch(/^"compact-issues:/);
    expect(bare.body).toHaveLength(2);
    expect(bare.body[0]).toHaveProperty("description");
    // view=full stays invalid for the board (the UI compatibility contract).
    await request(routeApp(ctx.db, company.actor as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=full`)
      .expect(400);
    // The board's limit=1000 is clamped, not rejected.
    await request(routeApp(ctx.db, company.actor as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?limit=1000`)
      .expect(200);
    // The board's compact view keeps the description.
    const compact = await request(routeApp(ctx.db, company.actor as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=compact&limit=50`)
      .expect(200);
    expect(compact.body[0]).toHaveProperty("description");
  });

  it("serves ETag/304 for the agent and never mixes the toggled bodies", async () => {
    const { companyId } = await seedCompanyWithIssues(1);
    await setAgentDefaultsEnabled(null); // absent = enabled
    const actor = (await agentActor(companyId)) as never;
    const enabledRes = await request(routeApp(ctx.db, actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    expect(enabledRes.body[0]).not.toHaveProperty("description");
    const enabledEtag = enabledRes.headers.etag;
    expect(enabledEtag).toMatch(/^"compact-issues:/);

    // The conditional request is answered 304 against the same body.
    const conditional = await request(routeApp(ctx.db, actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .set("If-None-Match", enabledEtag)
      .expect(304);

    // Past the cache TTL, toggling the setting yields a different ETag whose
    // body carries the description again, and the old ETag no longer matches.
    await sleep(2100);
    await setAgentDefaultsEnabled(false);
    const disabledRes = await request(routeApp(ctx.db, actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    expect(disabledRes.headers.etag ?? "").not.toMatch(/^"compact-issues:/);
    expect(disabledRes.body[0]).toHaveProperty("description");
    await request(routeApp(ctx.db, actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .set("If-None-Match", enabledEtag)
      .expect(200);
    void conditional;
  });
});
