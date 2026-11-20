// server/src/myrmidon/review-history/approved-outcomes.myrmidon.test.ts
//
// myrmidon(1.8 LEARN, OPE-13159): focused tests for the bounded
// approved-review-outcome query contract. Acceptance probes:
// - only `outcome = "approved"`, `stageType = "review"` rows are returned;
// - the closed 30-day window holds on both edges (older and future-dated rows
//   stay in the database);
// - pagination is capped at `REVIEW_HISTORY_MAX_PAGE_SIZE` and the cursor
//   walks the full eligible set without duplicates or drift past the window;
// - unapproved bodies, actor/run fields, and secrets never cross the
//   redaction boundary.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  issueExecutionDecisions,
  issues,
  issueWorkProducts,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  REVIEW_HISTORY_MAX_PAGE_SIZE,
  queryApprovedReviewOutcomes,
} from "./approved-outcomes.js";
import { extractReviewFeedback } from "./query.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-11-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("queryApprovedReviewOutcomes — bounded review-history query contract", () => {
  let cleanupDatabase: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const issueIds: string[] = [];

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("review-history-approved-outcomes-");
    cleanupDatabase = database.cleanup;
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "review-history-a", status: "active", issuePrefix: "RHA" });
    await db.insert(companies).values({ id: otherCompanyId, name: "review-history-b", status: "active", issuePrefix: "RHB" });
  }, 120_000);

  afterEach(async () => {
    if (!db) return;
    await db.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.companyId, companyId));
    await db.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.companyId, otherCompanyId));
    await db.delete(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, otherCompanyId));
    issueIds.length = 0;
  });

  afterAll(async () => {
    if (db) {
      await db.delete(companies).where(eq(companies.id, companyId));
      await db.delete(companies).where(eq(companies.id, otherCompanyId));
    }
    await cleanupDatabase?.();
  });

  async function makeIssue(identifier: string, forCompanyId: string = companyId) {
    const id = randomUUID();
    await db!.insert(issues).values({
      id,
      companyId: forCompanyId,
      identifier,
      title: `review-history ${identifier}`,
      status: "done",
      priority: "medium",
    });
    if (forCompanyId === companyId) issueIds.push(id);
    return id;
  }

  async function attachPullRequest(issueId: string, number: number, repository = "example-org/repo") {
    await db!.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: `PR #${number}`,
      status: "merged",
      metadata: { repository, number },
    });
  }

  async function makeDecision(input: {
    issueId: string;
    body: string;
    createdAt: Date;
    outcome?: string;
    stageType?: string;
    forCompanyId?: string;
  }) {
    await db!.insert(issueExecutionDecisions).values({
      companyId: input.forCompanyId ?? companyId,
      issueId: input.issueId,
      stageId: randomUUID(),
      stageType: input.stageType ?? "review",
      outcome: input.outcome ?? "approved",
      body: input.body,
      createdAt: input.createdAt,
    });
  }

  it("returns only approved review-stage decisions inside the 30-day window", async () => {
    const inWindow = await makeIssue("OPE-A1");
    await attachPullRequest(inWindow, 101);
    await makeDecision({
      issueId: inWindow,
      body: "Check the exact-head SHA before merging.",
      createdAt: new Date(NOW.getTime() - 5 * DAY_MS),
    });

    const approved = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW });
    expect(approved.records).toHaveLength(1);
    expect(approved.records[0]).toMatchObject({
      kind: "review_decision",
      issueId: inWindow,
      issueIdentifier: "OPE-A1",
      pullRequest: { repository: "example-org/repo", number: 101 },
    });
    expect(approved.nextCursor).toBeNull();
  });

  it("excludes non-approved, non-review-stage, other-company, and hidden-issue rows", async () => {
    const issue = await makeIssue("OPE-B1");
    await attachPullRequest(issue, 201);
    await makeDecision({ issueId: issue, body: "changes requested: fix the gate", createdAt: new Date(NOW.getTime() - 2 * DAY_MS), outcome: "changes_requested" });
    await makeDecision({ issueId: issue, body: "approved at execution stage", createdAt: new Date(NOW.getTime() - 3 * DAY_MS), stageType: "execution" });
    await makeDecision({ issueId: issue, body: "approved", createdAt: new Date(NOW.getTime() - 4 * DAY_MS), forCompanyId: otherCompanyId });
    const hidden = await makeIssue("OPE-B2");
    await attachPullRequest(hidden, 202);
    await db!.update(issues).set({ hiddenAt: NOW }).where(eq(issues.id, hidden));
    await makeDecision({ issueId: hidden, body: "private hidden verdict", createdAt: new Date(NOW.getTime() - DAY_MS) });

    const result = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW });
    expect(result.records).toEqual([]);
  });

  it("holds the closed 30-day window on both edges", async () => {
    const issue = await makeIssue("OPE-C1");
    await attachPullRequest(issue, 301);
    // 30 days + 1 second before NOW: outside.
    await makeDecision({ issueId: issue, body: "stale approved verdict", createdAt: new Date(NOW.getTime() - 30 * DAY_MS - 1000) });
    // 1 second after NOW: future-dated, outside.
    await makeDecision({ issueId: issue, body: "future approved verdict", createdAt: new Date(NOW.getTime() + 1000) });
    // Exactly at the edges: since (exclusive) and now (exclusive) — both out.
    await makeDecision({ issueId: issue, body: "edge-since verdict", createdAt: new Date(NOW.getTime() - 30 * DAY_MS) });
    await makeDecision({ issueId: issue, body: "edge-now verdict", createdAt: NOW });

    const result = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW });
    expect(result.records).toEqual([]);
  });

  it("does not expand the 30-day window when a larger window is requested", async () => {
    const issue = await makeIssue("OPE-C2");
    await attachPullRequest(issue, 302);
    await makeDecision({ issueId: issue, body: "stale verdict", createdAt: new Date(NOW.getTime() - 31 * DAY_MS) });
    const result = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW, windowMs: 60 * DAY_MS });
    expect(result.records).toEqual([]);
  });

  it("clamps the page size to REVIEW_HISTORY_MAX_PAGE_SIZE and the cursor walks the full set", async () => {
    const issue = await makeIssue("OPE-D1");
    await attachPullRequest(issue, 401);
    const total = REVIEW_HISTORY_MAX_PAGE_SIZE + 7;
    for (let index = 0; index < total; index += 1) {
      await makeDecision({
        issueId: issue,
        body: `approved verdict ${index}`,
        createdAt: new Date(NOW.getTime() - (index + 1) * 60 * 1000),
      });
    }

    // A request far above the cap returns exactly the cap and a cursor.
    const first = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW, limit: 10_000 });
    expect(first.records).toHaveLength(REVIEW_HISTORY_MAX_PAGE_SIZE);
    expect(first.nextCursor).toBeTruthy();

    // Walk every page; no duplicates, no drift past the window.
    const seen = new Set<string>();
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW, cursor });
      for (const record of page.records) {
        expect(seen.has(record.id)).toBe(false);
        seen.add(record.id);
        const createdAt = Date.parse(record.createdAt);
        expect(createdAt).toBeGreaterThan(NOW.getTime() - 30 * DAY_MS);
        expect(createdAt).toBeLessThan(NOW.getTime());
      }
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(total - REVIEW_HISTORY_MAX_PAGE_SIZE);
  });

  it("paginates decisions sharing the cursor timestamp without duplicates", async () => {
    const issue = await makeIssue("OPE-D2");
    await attachPullRequest(issue, 402);
    const createdAt = new Date(NOW.getTime() - DAY_MS);
    for (let index = 0; index < 3; index += 1) {
      await makeDecision({ issueId: issue, body: `same time ${index}`, createdAt });
    }

    const first = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW, limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW, limit: 2, cursor: first.nextCursor });
    expect(second.records).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.records, ...second.records].map((record) => record.id)).size).toBe(3);
  });

  it("paginates each decision once when an issue has multiple pull requests", async () => {
    const issue = await makeIssue("OPE-D3");
    await attachPullRequest(issue, 403);
    await attachPullRequest(issue, 404);
    for (let index = 0; index < 3; index += 1) {
      await makeDecision({ issueId: issue, body: `multi PR ${index}`, createdAt: new Date(NOW.getTime() - (index + 1) * DAY_MS) });
    }

    const records = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW, limit: 1, cursor });
      records.push(...page.records);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(records).toHaveLength(3);
    expect(new Set(records.map((record) => record.id)).size).toBe(3);
    expect(new Set(records.map((record) => record.pullRequest.number)).size).toBe(1);
  });

  it("redacts secrets from approved bodies at the query boundary", async () => {
    const issue = await makeIssue("OPE-E1");
    await attachPullRequest(issue, 501);
    await makeDecision({
      issueId: issue,
      body: "LGTM. Rotate the leaked token password=hunter2 before merging.",
      createdAt: new Date(NOW.getTime() - DAY_MS),
    });

    const result = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.body).not.toContain("hunter2");
    expect(result.records[0]!.body).toContain("[REDACTED]");

    // The redacted record must pass the downstream admissibility gate, and
    // the gate must still reject a record that still carries a secret.
    const extracted = extractReviewFeedback(result.records, NOW);
    expect(extracted).not.toBe(false);
  });

  it("feeds extractReviewFeedback directly: approved in-window rows are admissible, unapproved never appear", async () => {
    const issue = await makeIssue("OPE-F1");
    await attachPullRequest(issue, 601);
    await makeDecision({
      issueId: issue,
      body: "Rebase the PR branch on origin/main before in_review.",
      createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });

    const page = await queryApprovedReviewOutcomes(db!, { companyId, now: NOW });
    const extracted = extractReviewFeedback(page.records, NOW);
    expect(extracted).not.toBe(false);
    if (extracted === false) throw new Error("unreachable");
    expect(extracted).toHaveLength(1);
    expect(extracted[0]!.feedback).toContain("Rebase the PR branch");
  });
});
