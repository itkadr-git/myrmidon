import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import { issueWorkProducts, issues, issueComments } from "@myrmidon/db";
import {
  fetchCommitCheckRuns,
  summarizeCheckRuns,
  createPullRequestCiResolver,
  withCiResolveDeadline,
  clearCiCacheForTests,
  type PullRequestCiJob,
} from "../github-pull-request-ci.js";
import { buildPaperclipTaskMarkdown } from "../heartbeat.js";

describe("summarizeCheckRuns", () => {
  it("returns no_checks and non-authoritative for empty runs", () => {
    const summary = summarizeCheckRuns([]);
    expect(summary.status).toBe("pending");
    expect(summary.conclusion).toBe("no_checks");
    expect(summary.authoritative).toBe(false);
    expect(summary.totalRuns).toBe(0);
    expect(summary.failedJobs).toEqual([]);
  });

  it("returns success and authoritative: true when all check runs succeed or are skipped", () => {
    const runs: PullRequestCiJob[] = [
      {
        id: 1,
        name: "test",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/itkadr-git/myrmidon-deploy/actions/runs/1/job/1",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: "2026-10-30T04:05:00Z",
      },
      {
        id: 2,
        name: "lint",
        status: "completed",
        conclusion: "skipped",
        url: "https://github.com/itkadr-git/myrmidon-deploy/actions/runs/1/job/2",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: "2026-10-30T04:01:00Z",
      },
    ];

    const summary = summarizeCheckRuns(runs);
    expect(summary.status).toBe("completed");
    expect(summary.conclusion).toBe("success");
    expect(summary.authoritative).toBe(true);
    expect(summary.totalRuns).toBe(2);
    expect(summary.successfulRuns).toBe(2);
    expect(summary.failedRuns).toBe(0);
    expect(summary.failedJobs).toEqual([]);
    expect(summary.completedAt).toBe("2026-10-30T04:05:00Z");
  });

  it("returns failure with failedJobs list and authoritative: true when any check run fails", () => {
    const runs: PullRequestCiJob[] = [
      {
        id: 101,
        name: "unit-tests",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/10/job/1",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: "2026-10-30T04:05:00Z",
      },
      {
        id: 102,
        name: "e2e-matrix",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/10/job/2",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: "2026-10-30T04:10:00Z",
      },
      {
        id: 103,
        name: "typecheck",
        status: "completed",
        conclusion: "timed_out",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/10/job/3",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: "2026-10-30T04:12:00Z",
      },
    ];

    const summary = summarizeCheckRuns(runs);
    expect(summary.status).toBe("completed");
    expect(summary.conclusion).toBe("failure");
    expect(summary.authoritative).toBe(true);
    expect(summary.totalRuns).toBe(3);
    expect(summary.successfulRuns).toBe(1);
    expect(summary.failedRuns).toBe(2);
    expect(summary.failedJobs).toEqual([
      {
        id: 102,
        name: "e2e-matrix",
        conclusion: "failure",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/10/job/2",
        completedAt: "2026-10-30T04:10:00Z",
      },
      {
        id: 103,
        name: "typecheck",
        conclusion: "timed_out",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/10/job/3",
        completedAt: "2026-10-30T04:12:00Z",
      },
    ]);
    expect(summary.completedAt).toBe("2026-10-30T04:12:00Z");
  });

  it("marks missing or denied or incomplete runs as non-authoritative", () => {
    const deniedRuns = Object.assign([] as PullRequestCiJob[], {
      authoritative: false,
      conclusion: "denied" as const,
      status: "unavailable" as const,
      summary: "checks unavailable (access denied)",
    });
    const deniedSummary = summarizeCheckRuns(deniedRuns);
    expect(deniedSummary.authoritative).toBe(false);
    expect(deniedSummary.conclusion).toBe("denied");
    expect(deniedSummary.status).toBe("unavailable");

    const incompleteRuns = Object.assign(
      [
        {
          id: 1,
          name: "test-1",
          status: "completed" as const,
          conclusion: "success" as const,
          url: "https://example.com",
          startedAt: null,
          completedAt: null,
        },
      ],
      {
        authoritative: false,
        conclusion: "incomplete" as const,
        status: "in_progress" as const,
        summary: "incomplete checks",
      },
    );
    const incSummary = summarizeCheckRuns(incompleteRuns);
    expect(incSummary.authoritative).toBe(false);
    expect(incSummary.conclusion).toBe("incomplete");
  });

  it("distinguishes required checks from optional checks (such as main-green)", () => {
    const runs: PullRequestCiJob[] = [
      {
        id: 1,
        name: "CI result",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/1/job/1",
        startedAt: null,
        completedAt: "2026-11-09T18:00:00Z",
      },
      {
        id: 2,
        name: "hot files review",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/1/job/2",
        startedAt: null,
        completedAt: "2026-11-09T18:05:00Z",
      },
      {
        id: 3,
        name: "main-green",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/1/job/3",
        startedAt: null,
        completedAt: "2026-11-09T18:10:00Z",
      },
    ];

    const summary = summarizeCheckRuns(runs);
    expect(summary.status).toBe("completed");
    expect(summary.conclusion).toBe("success");
    expect(summary.failedRuns).toBe(0);
    expect(summary.failedJobs).toEqual([]);
    expect(summary.optionalFailedJobs).toHaveLength(1);
    expect(summary.optionalFailedJobs?.[0].name).toBe("main-green");
    expect(summary.summary).toContain("success");
    expect(summary.summary).toContain("optional failed (не влияет)");
  });

  it("fails conclusion when a required check fails", () => {
    const runs: PullRequestCiJob[] = [
      {
        id: 1,
        name: "CI result",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/1/job/1",
        startedAt: null,
        completedAt: "2026-11-09T18:00:00Z",
      },
      {
        id: 2,
        name: "main-green",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/1/job/2",
        startedAt: null,
        completedAt: "2026-11-09T18:05:00Z",
      },
    ];

    const summary = summarizeCheckRuns(runs);
    expect(summary.status).toBe("completed");
    expect(summary.conclusion).toBe("failure");
    expect(summary.failedRuns).toBe(1);
    expect(summary.failedJobs[0].name).toBe("CI result");
  });

  it("returns in_progress and pending when some checks are running without failures", () => {
    const runs: PullRequestCiJob[] = [
      {
        id: 201,
        name: "lint",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/20/job/1",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: "2026-10-30T04:02:00Z",
      },
      {
        id: 202,
        name: "build",
        status: "in_progress",
        conclusion: null,
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/20/job/2",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: null,
      },
    ];

    const summary = summarizeCheckRuns(runs);
    expect(summary.status).toBe("in_progress");
    expect(summary.conclusion).toBe("pending");
    expect(summary.totalRuns).toBe(2);
    expect(summary.successfulRuns).toBe(1);
    expect(summary.failedRuns).toBe(0);
    expect(summary.failedJobs).toEqual([]);
  });

  it("returns in_progress and failure when a check has failed while another is still running", () => {
    const runs: PullRequestCiJob[] = [
      {
        id: 301,
        name: "lint",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/30/job/1",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: "2026-10-30T04:02:00Z",
      },
      {
        id: 302,
        name: "build",
        status: "in_progress",
        conclusion: null,
        url: "https://github.com/itkadr-git/myrmidon/actions/runs/30/job/2",
        startedAt: "2026-10-30T04:00:00Z",
        completedAt: null,
      },
    ];

    const summary = summarizeCheckRuns(runs);
    expect(summary.status).toBe("in_progress");
    expect(summary.conclusion).toBe("failure");
    expect(summary.failedRuns).toBe(1);
  });
});

describe("fetchCommitCheckRuns", () => {
  it("fetches check runs for exact head SHA with authorization header", async () => {
    const mockCheckRuns = [
      {
        id: 11,
        name: "ci/test",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/itkadr-git/myrmidon-deploy/runs/11",
        started_at: "2026-10-30T03:00:00Z",
        completed_at: "2026-10-30T03:05:00Z",
      },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        total_count: 1,
        check_runs: mockCheckRuns,
      }),
    });

    const result = await fetchCommitCheckRuns(
      "itkadr-git",
      "myrmidon-deploy",
      "abcdef1234567890abcdef1234567890abcdef12",
      "mock-app-token",
      mockFetch as never,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/itkadr-git/myrmidon-deploy/commits/abcdef1234567890abcdef1234567890abcdef12/check-runs?per_page=100&page=1&filter=latest",
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "myrmidon-ci-resolver",
          authorization: "Bearer mock-app-token",
        },
      },
    );

    expect(result.authoritative).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 11,
      name: "ci/test",
      status: "completed",
      conclusion: "success",
      url: "https://github.com/itkadr-git/myrmidon-deploy/runs/11",
      startedAt: "2026-10-30T03:00:00Z",
      completedAt: "2026-10-30T03:05:00Z",
    });
  });

  it("paginates through multiple pages when total_count > 100", async () => {
    const page1Runs = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `job-${i + 1}`,
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/itkadr-git/myrmidon/runs/${i + 1}`,
      started_at: "2026-10-30T04:00:00Z",
      completed_at: "2026-10-30T04:01:00Z",
    }));
    const page2Runs = [
      {
        id: 101,
        name: "job-101",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/itkadr-git/myrmidon/runs/101",
        started_at: "2026-10-30T04:00:00Z",
        completed_at: "2026-10-30T04:01:00Z",
      },
    ];

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("&page=1")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            total_count: 101,
            check_runs: page1Runs,
          }),
        };
      }
      if (url.includes("&page=2")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            total_count: 101,
            check_runs: page2Runs,
          }),
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const result = await fetchCommitCheckRuns(
      "itkadr-git",
      "myrmidon",
      "head-sha-with-many-runs",
      "mock-token",
      mockFetch as never,
    );

    expect(result).toHaveLength(101);
    expect(result.authoritative).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("marks 404 and 403 as non-authoritative missing/denied", async () => {
    const mockFetch404 = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    });

    const result404 = await fetchCommitCheckRuns(
      "itkadr-git",
      "myrmidon-deploy",
      "missing-sha",
      null,
      mockFetch404 as never,
    );

    expect(result404.authoritative).toBe(false);
    expect(result404.conclusion).toBe("missing");
    expect(result404).toHaveLength(0);

    const mockFetch403 = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
    });

    const result403 = await fetchCommitCheckRuns(
      "itkadr-git",
      "myrmidon-deploy",
      "denied-sha",
      null,
      mockFetch403 as never,
    );

    expect(result403.authoritative).toBe(false);
    expect(result403.conclusion).toBe("denied");

    const mockFetch403Pat = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: "Resource not accessible by personal access token" }),
    });
    const result403WithToken = await fetchCommitCheckRuns(
      "itkadr-git",
      "myrmidon-deploy",
      "denied-sha",
      "pat-token",
      mockFetch403Pat as never,
    );
    expect(result403WithToken.summary).toBe("checks unavailable (token lacks checks/actions read)");
  });
});

describe("createPullRequestCiResolver", () => {
  beforeEach(() => {
    clearCiCacheForTests();
  });
  it("resolves CI result for pull request with caching", async () => {
    const mockDb = {
      select: vi.fn(),
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/pulls/124")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "open",
            head: { sha: "head-sha-deploy-124", ref: "bot/OPE-9525" },
            base: { ref: "main" },
            draft: false,
          }),
        };
      }
      if (url.includes("/commits/head-sha-deploy-124/check-runs")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            total_count: 2,
            check_runs: [
              {
                id: 1,
                name: "deploy-test",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/itkadr-git/myrmidon-deploy/runs/1",
                started_at: "2026-10-30T04:00:00Z",
                completed_at: "2026-10-30T04:05:00Z",
              },
              {
                id: 2,
                name: "deploy-smoke",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/itkadr-git/myrmidon-deploy/runs/2",
                started_at: "2026-10-30T04:00:00Z",
                completed_at: "2026-10-30T04:06:00Z",
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
    });

    const ciResult = await resolver.resolveForPullRequest("company-1", {
      host: "github.com",
      owner: "itkadr-git",
      repo: "myrmidon-deploy",
      number: 124,
    });

    expect(ciResult.repository).toBe("itkadr-git/myrmidon-deploy");
    expect(ciResult.pullNumber).toBe(124);
    expect(ciResult.headSha).toBe("head-sha-deploy-124");
    expect(ciResult.headRef).toBe("bot/OPE-9525");
    expect(ciResult.status).toBe("completed");
    expect(ciResult.conclusion).toBe("success");
    expect(ciResult.authoritative).toBe(true);
    expect(ciResult.totalRuns).toBe(2);
    expect(ciResult.failedJobs).toHaveLength(0);

    // Call again to verify cache hit
    const cachedResult = await resolver.resolveForPullRequest("company-1", {
      host: "github.com",
      owner: "itkadr-git",
      repo: "myrmidon-deploy",
      number: 124,
    });
    expect(cachedResult).toEqual(ciResult);
  });

  it("handles denied access or missing head SHA as non-authoritative", async () => {
    const mockDb = { select: vi.fn() };
    const resolver = createPullRequestCiResolver(mockDb as never, {
      prResolver: async () => ({
        headSha: null,
        headRef: null,
        access: "denied",
      }),
    });

    const res = await resolver.resolveForPullRequest("company-1", {
      host: "github.com",
      owner: "itkadr-git",
      repo: "myrmidon-deploy",
      number: 57,
    });

    expect(res.authoritative).toBe(false);
    expect(res.status).toBe("unavailable");
    expect(res.conclusion).toBe("denied");
  });

  it("resolves CI for linked deploy PR discovered via issue work products and comments", async () => {
    // Mock DB queries for resolveForIssue
    const mockWorkProducts = [
      {
        url: "https://github.com/itkadr-git/myrmidon/pull/2024",
        title: "PR #2024",
        metadata: {
          repo: "itkadr-git/myrmidon-deploy",
          number: 57,
        },
      },
    ];
    const mockIssue = {
      title: "Task with deploy",
      description: "Deployment PR: https://github.com/itkadr-git/myrmidon-deploy/pull/57",
    };
    const mockComments = [
      {
        body: "Verified against itkadr-git/myrmidon-deploy#57 head",
      },
    ];

    const mockDb = {
      select: vi.fn().mockImplementation((fields?: unknown) => {
        return {
          from: vi.fn().mockImplementation((table: unknown) => {
            return {
              where: vi.fn().mockImplementation(async () => {
                // Table checks
                let tableName: string | undefined;
                try {
                  tableName = getTableName(table as Parameters<typeof getTableName>[0]);
                } catch {
                  tableName = (table as { _?: { name?: string } })?._?.name;
                }
                if (table === issueWorkProducts || tableName === "issue_work_products") {
                  return mockWorkProducts;
                }
                if (table === issueComments || tableName === "issue_comments") {
                  return mockComments;
                }
                if (table === issues || tableName === "issues") {
                  if (fields && typeof fields === "object" && "parentId" in (fields as Record<string, unknown>)) {
                    return [];
                  }
                  return [mockIssue];
                }
                return [];
              }),
            };
          }),
        };
      }),
    };

    const resolver = createPullRequestCiResolver(mockDb as never, {
      prResolver: async (_companyId, ref) => {
        if (ref.repo === "myrmidon-deploy" && ref.number === 57) {
          return {
            headSha: "028fc07deploy",
            headRef: "bot/OPE-7264",
          };
        }
        return {
          headSha: "2588e25myrmidon",
          headRef: "bot/OPE-9964",
        };
      },
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          total_count: 1,
          check_runs: [
            {
              id: 99,
              name: "deploy-validation",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/itkadr-git/myrmidon-deploy/runs/99",
              started_at: "2026-10-30T05:00:00Z",
              completed_at: "2026-10-30T05:05:00Z",
            },
          ],
        }),
      }) as never,
      tokenProvider: async () => "mock-token",
    });

    const results = await resolver.resolveForIssue("comp-1", "issue-1");
    expect(results).toHaveLength(2);

    const deployCi = results.find((r) => r.repository === "itkadr-git/myrmidon-deploy");
    expect(deployCi).toBeDefined();
    expect(deployCi?.pullNumber).toBe(57);
    expect(deployCi?.headSha).toBe("028fc07deploy");
    expect(deployCi?.status).toBe("completed");
    expect(deployCi?.conclusion).toBe("success");
    expect(deployCi?.authoritative).toBe(true);

    const myrmidonCi = results.find((r) => r.repository === "itkadr-git/myrmidon");
    expect(myrmidonCi).toBeDefined();
    expect(myrmidonCi?.pullNumber).toBe(2024);

    // Behavioral test: verify reviewer-run context includes exact deploy PR CI and directive
    const reviewerMarkdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "OPE-9964",
        title: "Task with deploy",
        status: "in_review",
        workMode: "standard",
      },
      wakePayload: {
        pullRequestsCi: results,
      },
    });

    expect(reviewerMarkdown).toContain("Pull Request CI Status (board-verified on exact head SHA):");
    expect(reviewerMarkdown).toContain("- Repository: itkadr-git/myrmidon-deploy (PR #57)");
    expect(reviewerMarkdown).toContain("  - Head SHA: 028fc07deploy");
    expect(reviewerMarkdown).toContain("  - CI Result: SUCCESS (success (1/1 passed))");
    expect(reviewerMarkdown).toContain("  - Authoritative: true");
    expect(reviewerMarkdown).toContain("Reviewer directive:");
    expect(reviewerMarkdown).toContain(
      "Base your review verdict strictly on this board-provided CI status for the exact head SHA. Do not call `gh pr checks`.",
    );
  });

  it("renders non-authoritative warning in reviewer context when deploy PR checks are denied or incomplete", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "OPE-9964",
        title: "Task with deploy",
        status: "in_review",
        workMode: "standard",
      },
      wakePayload: {
        pullRequestsCi: [
          {
            repository: "itkadr-git/myrmidon-deploy",
            pullNumber: 57,
            headSha: "028fc07deploy",
            headRef: "bot/OPE-7264",
            status: "unavailable",
            conclusion: "denied",
            summary: "checks unavailable (access denied)",
            authoritative: false,
            checkedAt: "2026-10-30T05:00:00Z",
            completedAt: null,
            totalRuns: 0,
            successfulRuns: 0,
            failedRuns: 0,
            failedJobs: [],
            runs: [],
          },
        ],
      },
    });

    expect(markdown).toContain("- Repository: itkadr-git/myrmidon-deploy (PR #57)");
    expect(markdown).toContain("  - Authoritative: false");
    expect(markdown).toContain("  - CI Result: DENIED (checks unavailable (access denied))");
    expect(markdown).toContain("Reviewer directive:");
    expect(markdown).toContain(
      "Some or all PR check runs are non-authoritative (missing, denied, or incomplete). Do not assume unverified checks passed.",
    );
  });

  it("renders live pullRequestsCi over stale wakePayload when provided", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "OPE-12534",
        title: "Reviewer CI test",
        status: "in_review",
        workMode: "standard",
      },
      wakePayload: {
        pullRequestsCi: [
          {
            repository: "itkadr-git/myrmidon",
            pullNumber: 2800,
            headSha: "head-sha-123",
            headRef: "bot/OPE-12534",
            status: "completed",
            conclusion: "failure",
            summary: "failure (1 failed, 1 passed)",
            authoritative: true,
            checkedAt: "2026-11-09T18:00:00Z",
            completedAt: "2026-11-09T18:00:00Z",
            totalRuns: 2,
            successfulRuns: 1,
            failedRuns: 1,
            failedJobs: [
              {
                id: 3,
                name: "main-green",
                conclusion: "failure",
                url: "https://example.com/job/3",
                completedAt: "2026-11-09T18:00:00Z",
              },
            ],
            runs: [],
          },
        ],
      },
      pullRequestsCi: [
        {
          repository: "itkadr-git/myrmidon",
          pullNumber: 2800,
          headSha: "head-sha-123",
          headRef: "bot/OPE-12534",
          status: "completed",
          conclusion: "success",
          summary: "success (2/2 passed)",
          authoritative: true,
          checkedAt: "2026-11-09T18:30:00Z",
          completedAt: "2026-11-09T18:30:00Z",
          totalRuns: 2,
          successfulRuns: 2,
          failedRuns: 0,
          failedJobs: [],
          optionalFailedJobs: [],
          runs: [],
        },
      ],
    });

    expect(markdown).toContain("- CI Result: SUCCESS (success (2/2 passed))");
    expect(markdown).toContain("Checked at: 2026-11-09T18:30:00Z");
    expect(markdown).not.toContain("CI Result: FAILURE");
  });

  it("handles fetch network failure or timeout as non-authoritative unavailable without throwing", async () => {
    const mockDb = { select: vi.fn() };
    const mockFetch = vi.fn().mockRejectedValue(new Error("fetch timeout / abort"));
    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      prResolver: async () => ({
        headSha: "head-sha-fetch-fail",
        headRef: "bot/test",
      }),
      tokenProvider: async () => "token-123",
    });

    const result = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 10,
    });

    expect(result.status).toBe("unavailable");
    expect(result.conclusion).toBe("unavailable");
    expect(result.authoritative).toBe(false);
    expect(result.summary).toContain("checks unavailable");
  });

  it("handles tokenProvider failure as non-authoritative unavailable without throwing", async () => {
    const mockDb = { select: vi.fn() };
    const resolver = createPullRequestCiResolver(mockDb as never, {
      prResolver: async () => ({
        headSha: "head-sha-token-fail",
        headRef: "bot/test",
      }),
      tokenProvider: async () => {
        throw new Error("vault inaccessible");
      },
    });

    const result = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 10,
    });

    expect(result.status).toBe("unavailable");
    expect(result.conclusion).toBe("unavailable");
    expect(result.authoritative).toBe(false);
    expect(result.summary).toContain("token provider error");
  });

  it("withCiResolveDeadline returns fallback when resolution exceeds deadline", async () => {
    const slowPromise = new Promise<string[]>((resolve) => {
      setTimeout(() => resolve(["result"]), 100);
    });

    const result = await withCiResolveDeadline(slowPromise, ["fallback"], 10);
    expect(result).toEqual(["fallback"]);
  });

  it("acceptance: rate limit 403 gives rate_limited, not denied", async () => {
    const mockDb = { select: vi.fn() };
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/pulls/10")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "open",
            head: { sha: "head-sha-rate-limit", ref: "bot/rate-limit" },
            base: { ref: "main" },
            draft: false,
          }),
        };
      }
      if (url.includes("/commits/head-sha-rate-limit/check-runs")) {
        return {
          ok: false,
          status: 403,
          headers: new Headers({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1800000000",
          }),
          clone: () => ({ text: async () => "API rate limit exceeded" }),
          text: async () => "API rate limit exceeded",
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
      prResolver: async () => ({ headSha: "head-sha-rate-limit", headRef: "bot/rate-limit" }),
    });

    const res = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 10,
    });

    expect(res.status).toBe("unavailable");
    expect(res.conclusion).toBe("rate_limited");
    expect(res.authoritative).toBe(false);
    expect(res.summary).toContain("checks unavailable (GitHub rate limit until");
  });

  it("acceptance: response 200 with remaining=935 and reset in future executes request and does not mark rate_limited", async () => {
    const mockDb = { select: vi.fn() };
    let callsCount = 0;
    const futureReset = String(Math.floor(Date.now() / 1000) + 1800);
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callsCount++;
      if (url.includes("/pulls/10")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "x-ratelimit-remaining": "936",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": futureReset,
          }),
          json: async () => ({
            state: "open",
            head: { sha: "head-sha-200-test", ref: "bot/test-200" },
            base: { ref: "main" },
            draft: false,
          }),
        };
      }
      if (url.includes("/commits/head-sha-200-test/check-runs")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "x-ratelimit-remaining": "935",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": futureReset,
          }),
          json: async () => ({
            total_count: 1,
            check_runs: [
              {
                id: 1,
                name: "test",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/itkadr-git/myrmidon/actions/runs/1/job/1",
                started_at: "2026-11-05T04:00:00Z",
                completed_at: "2026-11-05T04:05:00Z",
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
      prResolver: async () => ({ headSha: "head-sha-200-test", headRef: "bot/test-200" }),
    });

    const res = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 10,
    });

    expect(callsCount).toBeGreaterThan(0);
    expect(res.status).toBe("completed");
    expect(res.conclusion).toBe("success");
    expect(res.authoritative).toBe(true);
    expect(res.summary).toContain("success (1/1 passed)");
  });

  it("acceptance: repeated call before reset does not call GitHub", async () => {
    const mockDb = { select: vi.fn() };
    let callsCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callsCount++;
      if (url.includes("/pulls/10")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "open",
            head: { sha: "head-sha-repeat-test", ref: "bot/repeat" },
            base: { ref: "main" },
          }),
        };
      }
      if (url.includes("/commits/head-sha-repeat-test/check-runs")) {
        return {
          ok: false,
          status: 403,
          headers: new Headers({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          }),
          clone: () => ({ text: async () => "API rate limit exceeded" }),
          text: async () => "API rate limit exceeded",
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
      prResolver: async () => ({ headSha: "head-sha-repeat-test", headRef: "bot/repeat" }),
    });

    const first = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 10,
    });
    expect(first.conclusion).toBe("rate_limited");
    expect(first.summary).toContain("checks unavailable (GitHub rate limit until");
    const countAfterFirst = callsCount;

    const second = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 10,
    });
    expect(callsCount).toBe(countAfterFirst);
    expect(second.conclusion).toBe("rate_limited");
    expect(second.summary).toContain("checks unavailable (GitHub rate limit until");
  });

  it("acceptance: repeated call after previous fetch returns stale cached results marked as устарел", async () => {
    const mockDb = { select: vi.fn() };
    let callsCount = 0;
    let failCheckRuns = false;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callsCount++;
      if (url.includes("/pulls/12")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "open",
            head: { sha: "head-sha-stale-cached", ref: "bot/stale" },
            base: { ref: "main" },
          }),
        };
      }
      if (url.includes("/commits/head-sha-stale-cached/check-runs")) {
        if (!failCheckRuns) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ etag: '"etag-init"' }),
            json: async () => ({
              total_count: 1,
              check_runs: [
                {
                  id: 201,
                  name: "ci-check",
                  status: "in_progress",
                  conclusion: null,
                  started_at: "2026-11-03T10:00:00Z",
                  completed_at: null,
                },
              ],
            }),
          };
        }
        return {
          ok: false,
          status: 403,
          headers: new Headers({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          }),
          clone: () => ({ text: async () => "API rate limit exceeded" }),
          text: async () => "API rate limit exceeded",
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
      prResolver: async () => ({ headSha: "head-sha-stale-cached", headRef: "bot/stale" }),
    });

    const initial = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 12,
    });
    expect(initial.status).toBe("in_progress");

    failCheckRuns = true;
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      const second = await resolver.resolveForPullRequest("company-1", {
        owner: "itkadr-git",
        repo: "myrmidon",
        number: 12,
      });
      expect(second.conclusion).toBe("rate_limited");
      expect(second.summary).toContain("устарел");
      expect(second.summary).toContain("GitHub rate limit until");
    } finally {
      now.mockRestore();
    }
  });

  it("acceptance: completed CI for same head is taken from cache", async () => {
    const mockDb = { select: vi.fn() };
    let callsCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callsCount++;
      if (url.includes("/pulls/11")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            state: "open",
            head: { sha: "head-sha-completed-cached", ref: "bot/cached" },
            base: { ref: "main" },
          }),
        };
      }
      if (url.includes("/commits/head-sha-completed-cached/check-runs")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ etag: '"etag-c1"' }),
          json: async () => ({
            total_count: 1,
            check_runs: [
              {
                id: 101,
                name: "unit-test",
                status: "completed",
                conclusion: "success",
                started_at: "2026-11-03T10:00:00Z",
                completed_at: "2026-11-03T10:05:00Z",
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
    });

    const res1 = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 11,
    });
    expect(res1.status).toBe("completed");
    expect(res1.conclusion).toBe("success");
    const countAfterFirst = callsCount;

    const res2 = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 11,
    });
    expect(callsCount).toBe(countAfterFirst);
    expect(res2).toEqual(res1);
  });

  it("acceptance: 304 with ETag returns cached result", async () => {
    const mockDb = { select: vi.fn() };
    let fetchRunsCalls = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes("/pulls/12")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ etag: '"pr-etag-1"' }),
          json: async () => ({
            state: "open",
            head: { sha: "head-sha-etag-304", ref: "bot/etag" },
            base: { ref: "main" },
          }),
        };
      }
      if (url.includes("/commits/head-sha-etag-304/check-runs")) {
        fetchRunsCalls++;
        if (
          (init?.headers?.["If-None-Match"] === '"etag-checkruns-1"' ||
            init?.headers?.["if-none-match"] === '"etag-checkruns-1"')
        ) {
          return {
            ok: false,
            status: 304,
            headers: new Headers({ etag: '"etag-checkruns-1"' }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ etag: '"etag-checkruns-1"' }),
          json: async () => ({
            total_count: 1,
            check_runs: [
              {
                id: 201,
                name: "lint",
                status: "completed",
                conclusion: "success",
                started_at: "2026-11-03T10:00:00Z",
                completed_at: "2026-11-03T10:05:00Z",
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, headers: new Headers() };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
    });

    const res1 = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon",
      number: 12,
    });
    expect(res1.status).toBe("completed");
    expect(res1.conclusion).toBe("success");
    expect(fetchRunsCalls).toBe(1);

    const runs304 = await fetchCommitCheckRuns(
      "itkadr-git",
      "myrmidon",
      "head-sha-etag-304",
      "token-123",
      mockFetch as never,
      { etag: '"etag-checkruns-1"' },
    );
    expect(runs304.summary).toBe("checks unchanged (not modified)");
    expect(fetchRunsCalls).toBe(2);
  });
});
