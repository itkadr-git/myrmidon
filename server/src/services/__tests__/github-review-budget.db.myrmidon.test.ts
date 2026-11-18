import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, instanceSettings, toolGatewayRateLimitCounters } from "@myrmidon/db";
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
});
