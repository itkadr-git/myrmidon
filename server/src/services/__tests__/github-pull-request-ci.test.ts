import { describe, expect, it, vi } from "vitest";
import {
  fetchCommitCheckRuns,
  summarizeCheckRuns,
  createPullRequestCiResolver,
  type PullRequestCiJob,
} from "../github-pull-request-ci.js";

describe("summarizeCheckRuns", () => {
  it("returns no_checks for empty runs", () => {
    const summary = summarizeCheckRuns([]);
    expect(summary.status).toBe("pending");
    expect(summary.conclusion).toBe("no_checks");
    expect(summary.totalRuns).toBe(0);
    expect(summary.failedJobs).toEqual([]);
  });

  it("returns success when all check runs succeed or are skipped", () => {
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
    expect(summary.totalRuns).toBe(2);
    expect(summary.successfulRuns).toBe(2);
    expect(summary.failedRuns).toBe(0);
    expect(summary.failedJobs).toEqual([]);
    expect(summary.completedAt).toBe("2026-10-30T04:05:00Z");
  });

  it("returns failure with failedJobs list when any check run fails", () => {
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
      "https://api.github.com/repos/itkadr-git/myrmidon-deploy/commits/abcdef1234567890abcdef1234567890abcdef12/check-runs?per_page=100&filter=latest",
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "myrmidon-ci-resolver",
          authorization: "Bearer mock-app-token",
        },
      },
    );

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

  it("returns empty array on 404 or 422", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await fetchCommitCheckRuns(
      "itkadr-git",
      "myrmidon-deploy",
      "missing-sha",
      null,
      mockFetch as never,
    );

    expect(result).toEqual([]);
  });
});

describe("createPullRequestCiResolver", () => {
  it("resolves CI result for pull request with caching", async () => {
    const mockDb = {
      select: vi.fn(),
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/pulls/124")) {
        return {
          ok: true,
          status: 200,
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
      return { ok: false, status: 404 };
    });

    const resolver = createPullRequestCiResolver(mockDb as never, {
      fetch: mockFetch as never,
      tokenProvider: async () => "token-123",
    });

    const ciResult = await resolver.resolveForPullRequest("company-1", {
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
    expect(ciResult.totalRuns).toBe(2);
    expect(ciResult.failedJobs).toHaveLength(0);

    // Call again to verify cache hit
    const cachedResult = await resolver.resolveForPullRequest("company-1", {
      owner: "itkadr-git",
      repo: "myrmidon-deploy",
      number: 124,
    });
    expect(cachedResult).toEqual(ciResult);
  });
});
