import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { reserveGitHubReviewRequest, withGitHubReviewBudget } from "../github-rate-limit.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("shared GitHub review budget", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-github-review-budget-");
    db = createDb(tempDb.connectionString);
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
});
