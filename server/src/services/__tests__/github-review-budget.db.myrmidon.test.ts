import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
import { companies, connectionEventDeliveries, createDb, instanceSettings, issueWorkProducts, issues, toolGatewayRateLimitCounters } from "@myrmidon/db";
import { createReviewPullRequestCiResolver, resetReviewCiCacheForTests } from "../../myrmidon/review-stage-recovery/github-ci.js";
import { resetGitHubRateLimitForTests } from "../github-rate-limit.js";
import { like, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { reserveGitHubReviewRequest, withGitHubReviewBudget } from "../github-review-budget.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("shared GitHub review budget", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-github-review-budget-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ name: "Budget Test Co", issuePrefix: "BUD" });
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  it("atomically shares 40 percent of the installation budget between both review sources", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      reserveGitHubReviewRequest(db, index % 2 ? "review-rework" : "review-recovery", 25),
    ));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await reserveGitHubReviewRequest(db, "review-rework", 25)).toBe(false);
    let calls = 0;
    const fetch = withGitHubReviewBudget(db, "review-recovery", async () => {
      calls++;
      return new Response("ok");
    }, 25);
    await expect(fetch("https://api.github.com/test")).rejects.toThrow("review budget exhausted");
    expect(calls).toBe(0);
  });

  it("permits exactly one transport at the default 1999-request boundary", async () => {
    await db.delete(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    const [company] = await db.select().from(companies).limit(1);
    if (!company) throw new Error("Budget test company missing");
    const [clock] = await db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute);
    const windowStart = new Date(minute * 60_000);
    await db.insert(toolGatewayRateLimitCounters).values({
      companyId: company.id,
      counterKey: `github-budget:review-rework:${minute}`,
      windowStartAt: windowStart,
      windowMs: 60_000,
      limit: 2000,
      count: 1999,
      resetAt: new Date(windowStart.getTime() + 3_600_000),
    });
    let calls = 0;
    const transport = withGitHubReviewBudget(db, "review-recovery", async () => {
      calls++;
      return new Response("ok");
    });
    await expect(transport("https://api.github.com/test")).resolves.toHaveProperty("status", 200);
    await expect(transport("https://api.github.com/test")).rejects.toThrow("review budget exhausted");
    expect(calls).toBe(1);
    await db.delete(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      reserveGitHubReviewRequest(db, index % 2 ? "review-rework" : "review-recovery", 25),
    ));
  });

  it("OPE-13942: counters live in tool_gateway_rate_limit_counters (one row per source and minute); instance_settings gets no extra row", async () => {
    const rows = await db.select().from(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(10);
    expect(rows.every((row) => /^github-budget:(review-recovery|review-rework|board-merge):\d+$/.test(row.counterKey) && row.windowMs === 60_000)).toBe(true);
    expect((await db.select().from(instanceSettings)).filter((row) => row.singletonKey !== "default")).toHaveLength(0);
  });

  it("OPE-13942: the board merge is counted in the same hour but keeps going after the review share is gone", async () => {
    // The previous test left the review share (10 of 25) used up in the current hour.
    expect(await reserveGitHubReviewRequest(db, "review-recovery", 25)).toBe(false);
    const merges = await Promise.all(Array.from({ length: 20 }, () => reserveGitHubReviewRequest(db, "board-merge", 25)));
    // 90 percent of 25 is 22: 10 already used, 12 more for the merge, then it stops as well.
    expect(merges.filter(Boolean)).toHaveLength(12);
    expect(await reserveGitHubReviewRequest(db, "board-merge", 25)).toBe(false);
  });

  it("allows only one concurrent transport when the default budget has one reservation left", async () => {
    await db.delete(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    const [company] = await db.select().from(companies).limit(1);
    if (!company) throw new Error("Budget test company missing");
    const [clock] = await db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute);
    const windowStart = new Date(minute * 60_000);
    await db.insert(toolGatewayRateLimitCounters).values({
      companyId: company.id,
      counterKey: `github-budget:board-merge:${minute}`,
      windowStartAt: windowStart,
      windowMs: 60_000,
      limit: 4500,
      count: 1999,
      resetAt: new Date(windowStart.getTime() + 3_600_000),
    });
    let calls = 0;
    const transport = withGitHubReviewBudget(db, "review-recovery", async () => {
      calls++;
      return new Response("ok");
    });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => transport("https://api.github.com/test")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(19);
    expect(calls).toBe(1);
  });

  it("exposes exhaustion rather than network error in the real resolver after its final reservation", async () => {
    await db.delete(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    resetReviewCiCacheForTests();
    resetGitHubRateLimitForTests();
    const [company] = await db.select().from(companies).limit(1);
    if (!company) throw new Error("Budget test company missing");
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Budget resolver", status: "in_progress", priority: "medium" }).returning();
    if (!issue) throw new Error("Budget test issue missing");
    const headSha = "a".repeat(40);
    await db.insert(issueWorkProducts).values({ companyId: company.id, issueId: issue.id, type: "pull_request", provider: "github", title: "Synthetic PR", url: "https://github.com/acme/app/pull/7", status: "open", isPrimary: true, metadata: { repo: "acme/app", number: 7, headSha } });
    const [clock] = await db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute);
    const windowStart = new Date(minute * 60_000);
    await db.insert(toolGatewayRateLimitCounters).values({ companyId: company.id, counterKey: `github-budget:review-rework:${minute}`, windowStartAt: windowStart, windowMs: 60_000, limit: 2000, count: 1999, resetAt: new Date(windowStart.getTime() + 3_600_000) });
    const calls: string[] = [];
    const resolve = createReviewPullRequestCiResolver({ db, tokenProvider: async () => null, fetch: async (url) => {
      calls.push(url);
      if (url !== "https://api.github.com/repos/acme/app/pulls/7") throw new Error("Unexpected synthetic transport URL");
      return Response.json({ state: "open", head: { sha: headSha } });
    } });
    const result = await resolve({ companyId: company.id, issueId: issue.id });
    expect(calls).toEqual(["https://api.github.com/repos/acme/app/pulls/7"]);
    expect(result.state).toBe("unknown");
    expect(result.reason).toContain("budget_exhausted");
    expect(result.reason).not.toContain("network_error");
  });

  it("does not call transport when the real resolver starts at used 2000", async () => {
    await db.delete(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    resetReviewCiCacheForTests();
    resetGitHubRateLimitForTests();
    const [company] = await db.select().from(companies).limit(1);
    if (!company) throw new Error("Budget test company missing");
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Exhausted resolver", status: "in_progress", priority: "medium" }).returning();
    if (!issue) throw new Error("Budget test issue missing");
    const headSha = "b".repeat(40);
    await db.insert(issueWorkProducts).values({ companyId: company.id, issueId: issue.id, type: "pull_request", provider: "github", title: "Synthetic PR", url: "https://github.com/acme/app/pull/7", status: "open", isPrimary: true, metadata: { repo: "acme/app", number: 7, headSha } });
    const [clock] = await db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute);
    const windowStart = new Date(minute * 60_000);
    await db.insert(toolGatewayRateLimitCounters).values({ companyId: company.id, counterKey: `github-budget:review-rework:${minute}`, windowStartAt: windowStart, windowMs: 60_000, limit: 2000, count: 2000, resetAt: new Date(windowStart.getTime() + 3_600_000) });
    let calls = 0;
    const resolve = createReviewPullRequestCiResolver({ db, tokenProvider: async () => null, fetch: async () => {
      calls++;
      throw new Error("Unexpected synthetic transport call");
    } });
    const result = await resolve({ companyId: company.id, issueId: issue.id });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ state: "unknown", reason: expect.stringContaining("budget_exhausted") });
    expect(result.reason).not.toContain("network_error");
  });

  it.each([
    { name: "fresh matching", webhook: true, age: 0, webhookHead: "a", checkHead: "a", calls: 1, state: "complete" },
    { name: "missing", webhook: false, age: 0, webhookHead: "a", checkHead: "a", calls: 3, state: "unknown" },
    { name: "stale", webhook: true, age: 31, webhookHead: "a", checkHead: "a", calls: 3, state: "unknown" },
    { name: "moved head", webhook: true, age: 0, webhookHead: "b", checkHead: "b", calls: 3, state: "unknown" },
    { name: "foreign check head", webhook: true, age: 0, webhookHead: "a", checkHead: "b", calls: 3, state: "unknown" },
  ])("uses $name webhook CI evidence only with a confirmed current head", async ({ webhook, age, webhookHead, checkHead, calls, state }) => {
    await db.delete(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    await db.delete(connectionEventDeliveries);
    resetReviewCiCacheForTests();
    resetGitHubRateLimitForTests();
    const [company] = await db.select().from(companies).limit(1);
    if (!company) throw new Error("Budget test company missing");
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Webhook resolver", status: "in_progress", priority: "medium" }).returning();
    if (!issue) throw new Error("Budget test issue missing");
    const headSha = "a".repeat(40);
    await db.insert(issueWorkProducts).values({ companyId: company.id, issueId: issue.id, type: "pull_request", provider: "github", title: "Synthetic PR", url: "https://github.com/acme/app/pull/7", status: "open", isPrimary: true, metadata: { repo: "acme/app", number: 7, headSha } });
    if (webhook) {
      const createdAt = new Date(Date.now() - age * 60_000);
      await db.insert(connectionEventDeliveries).values([
        { companyId: company.id, provider: "github", providerDeliveryId: "synthetic-pr", event: "pull_request", status: "processed", createdAt, normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha: webhookHead.repeat(40) } },
        { companyId: company.id, provider: "github", providerDeliveryId: "synthetic-check", event: "check_run", status: "processed", createdAt, normalizedPayload: { repository: "acme/app", number: 7, headSha: checkHead.repeat(40), checkName: "CI result", status: "completed", conclusion: "success" } },
      ]);
    }
    const seen: string[] = [];
    const transport = vi.fn(async (url: string) => {
      seen.push(url);
      // OPE-15114: the pull read confirms the current head; every other read
      // stays unreadable so an unconfirmed verdict fails closed.
      if (url === "https://api.github.com/repos/acme/app/pulls/7") return Response.json({ state: "open", head: { sha: headSha } });
      return new Response("", { status: 503 });
    });
    const resolve = createReviewPullRequestCiResolver({ db, fetch: transport, tokenProvider: async () => null });
    const result = await resolve({ companyId: company.id, issueId: issue.id });
    expect(result.state).toBe(state);
    expect(transport).toHaveBeenCalledTimes(calls);
    const prefix = "https://api.github.com/repos/acme/app";
    const expectedUrls = calls === 1 ? [`${prefix}/pulls/7`] : [
      `${prefix}/pulls/7`,
      `${prefix}/contents/.github/workflows`,
      `${prefix}/commits/${headSha}/check-runs?check_name=CI%20result&filter=all&per_page=100`,
    ];
    expect(seen).toEqual(expectedUrls);
    if (state === "complete") expect(result).toMatchObject({ headSha, finalCheckConclusion: "success" });
  });

  it("fails closed on a budget store exception without exposing its contents", async () => {
    const canary = "synthetic-secret-canary-OPE-15043";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    let calls = 0;
    try {
      const brokenDb = Object.create(db) as typeof db;
      brokenDb.transaction = async () => { throw new Error(canary); };
      const transport = withGitHubReviewBudget(brokenDb, "review-recovery", async () => {
        calls++;
        return new Response("ok");
      });
      let caught: unknown;
      try {
        await transport("https://api.github.com/test");
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ reason: "budget_store_unavailable" });
      expect(calls).toBe(0);
      expect(JSON.stringify({ error: String(caught), logs: warn.mock.calls })).not.toContain(canary);
    } finally {
      warn.mockRestore();
    }
  });

  it("excludes expired buckets and sums all three sources in the rolling window", async () => {
    await db.delete(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    const [company] = await db.select().from(companies).limit(1);
    if (!company) throw new Error("Budget test company missing");
    const [clock] = await db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute);
    const bucket = (source: string, age: number, count: number) => {
      const start = new Date((minute - age) * 60_000);
      return { companyId: company.id, counterKey: `github-budget:${source}:${minute - age}`, windowStartAt: start,
        windowMs: 60_000, limit: 2000, count, resetAt: new Date(start.getTime() + 3_600_000) };
    };
    await db.insert(toolGatewayRateLimitCounters).values([
      bucket("review-recovery", 0, 700),
      bucket("review-rework", 1, 699),
      bucket("board-merge", 2, 600),
      bucket("board-merge", 61, 2000),
    ]);
    let calls = 0;
    const transport = withGitHubReviewBudget(db, "review-recovery", async () => {
      calls++;
      return new Response("ok");
    });
    await expect(transport("https://api.github.com/test")).resolves.toHaveProperty("status", 200);
    await expect(transport("https://api.github.com/test")).rejects.toThrow("review budget exhausted");
    expect(calls).toBe(1);
    const rows = await db.select().from(toolGatewayRateLimitCounters).where(like(toolGatewayRateLimitCounters.counterKey, "github-budget:%"));
    expect(rows.filter((row) => row.windowStartAt.getTime() >= (minute - 59) * 60_000)
      .reduce((sum, row) => sum + row.count, 0)).toBe(2000);
  });
});
