import { describe, expect, it } from "vitest";
import { isIssueWaitingForPullRequestCi } from "./pr-waiting.js";

function createMockDb(product: any) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(product ? [product] : []),
        }),
      }),
    }),
  } as any;
}

describe("isIssueWaitingForPullRequestCi", () => {
  const companyId = "company-1";
  const issueId = "issue-1";

  it("returns false when no PR work product exists", async () => {
    const db = createMockDb(null);
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId });
    expect(waiting).toBe(false);
  });

  it("returns false when PR status is closed or merged", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "closed",
      reviewState: "none",
      healthStatus: "healthy",
      metadata: {},
      url: "https://github.com/org/repo/pull/1",
    });
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId });
    expect(waiting).toBe(false);
  });

  it("returns false when reviewState is changes_requested", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "changes_requested",
      healthStatus: "healthy",
      metadata: {},
      url: "https://github.com/org/repo/pull/1",
    });
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId });
    expect(waiting).toBe(false);
  });

  it("returns false when metadata reviewDecision is CHANGES_REQUESTED", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "none",
      healthStatus: "healthy",
      metadata: { reviewDecision: "CHANGES_REQUESTED" },
      url: "https://github.com/org/repo/pull/1",
    });
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId });
    expect(waiting).toBe(false);
  });

  it("returns false when metadata ci is not_green or healthStatus is unhealthy", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "none",
      healthStatus: "unhealthy",
      metadata: { ci: "not_green" },
      url: "https://github.com/org/repo/pull/1",
    });
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId });
    expect(waiting).toBe(false);
  });

  it("returns false when metadata draft is true", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "none",
      healthStatus: "healthy",
      metadata: { draft: true },
      url: "https://github.com/org/repo/pull/1",
    });
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId });
    expect(waiting).toBe(false);
  });

  it("returns true when open non-draft PR has pending/green CI and no changes requested", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "none",
      healthStatus: "healthy",
      metadata: { repo: "org/repo", number: 1, ci: "pending" },
      url: "https://github.com/org/repo/pull/1",
    });
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId });
    expect(waiting).toBe(true);
  });

  it("consults prResolver when provided and returns false if reviewDecision is CHANGES_REQUESTED", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "none",
      healthStatus: "healthy",
      metadata: { repo: "org/repo", number: 1 },
      url: "https://github.com/org/repo/pull/1",
    });
    const mockResolver = {
      resolve: async () => ({
        open: true,
        draft: false,
        headSha: "abc",
        ci: "green" as const,
        reviewDecision: "CHANGES_REQUESTED" as const,
        mergeable: true,
      }),
    };
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId }, mockResolver as any);
    expect(waiting).toBe(false);
  });

  it("consults prResolver when provided and returns false if ci is not_green", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "none",
      healthStatus: "healthy",
      metadata: { repo: "org/repo", number: 1 },
      url: "https://github.com/org/repo/pull/1",
    });
    const mockResolver = {
      resolve: async () => ({
        open: true,
        draft: false,
        headSha: "abc",
        ci: "not_green" as const,
        reviewDecision: null,
        mergeable: true,
      }),
    };
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId }, mockResolver as any);
    expect(waiting).toBe(false);
  });

  it("consults prResolver when provided and returns true if ci is pending/green without changes requested", async () => {
    const db = createMockDb({
      id: "prod-1",
      status: "open",
      reviewState: "none",
      healthStatus: "healthy",
      metadata: { repo: "org/repo", number: 1 },
      url: "https://github.com/org/repo/pull/1",
    });
    const mockResolver = {
      resolve: async () => ({
        open: true,
        draft: false,
        headSha: "abc",
        ci: "pending" as const,
        reviewDecision: null,
        mergeable: true,
      }),
    };
    const waiting = await isIssueWaitingForPullRequestCi(db, { companyId, issueId }, mockResolver as any);
    expect(waiting).toBe(true);
  });
});
