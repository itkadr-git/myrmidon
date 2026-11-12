// @vitest-environment node
//
// myrmidon(OPE-12397): acceptance tests for GitHub rate limit and REVIEW-REWORK budget.
//
// Acceptance criteria:
// 1. On exhausted rate limit, background passes and provider make zero HTTP calls.
// 2. Repeated resolve of the same PR inside TTL does not hit the network.
// 3. After TTL expires, request sends If-None-Match, and 304 returns the cached snapshot.
// 4. REVIEW-REWORK reads each PR at most once per pass and evaluates every candidate task.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC,
} from "@myrmidon/shared";
import {
  resetGitHubObjectCacheForTests,
} from "../../services/github-external-object-provider.js";
import {
  getGitHubRateLimitMetrics,
  resetGitHubRateLimitForTests,
  setGitHubRateLimitForTests,
} from "../../services/github-rate-limit.js";
import {
  createPullRequestReviewFactsResolver,
} from "./resolver.js";
import {
  createReviewReworkSweep,
  type ReviewReworkSweepDeps,
} from "./sweep.js";
import type { CreateReworkTaskInput, ReworkCandidateRow, ReviewReworkStore } from "./store.js";
import type { ReviewReworkChildFacts, ReviewReworkTaskFacts } from "./domain.js";

const START = Date.parse("2026-11-09T00:00:00Z");
const START_SEC = Math.floor(START / 1000);
const PR_URL = "https://github.com/acme/repo/pull/484";
const HEAD_OLD = "da3364a2973ee31f0db15e9f5d6492f91880786c";

function at(seconds: number) {
  vi.setSystemTime(START + seconds * 1000);
}

function pullBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Feature PR",
    state: "open",
    draft: false,
    merged: false,
    updated_at: "2026-11-09T00:00:00Z",
    head: { ref: "feature", sha: HEAD_OLD },
    base: { ref: "main", repo: { default_branch: "main" } },
    ...overrides,
  };
}

function pullResponse(overrides: Record<string, unknown> = {}, etag = '"v1"', headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(pullBody(overrides)), {
    status: 200,
    headers: { "content-type": "application/json", etag, ...headers },
  });
}

function notModified() {
  return new Response(null, { status: 304 });
}

function sentIfNoneMatch(init?: RequestInit) {
  return (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
}

function reviewTask(overrides: Partial<ReviewReworkTaskFacts> = {}): ReviewReworkTaskFacts {
  return {
    id: "review-1",
    companyId: "company-1",
    identifier: "OPE-4417",
    title: `Review PR ${PR_URL}`,
    status: "todo",
    assigneeAgentId: "reviewer-agent",
    assigneeUserId: null,
    projectId: null,
    goalId: null,
    billingCode: null,
    priority: "high",
    returnAssigneeAgentId: "author-agent",
    ...overrides,
  };
}

class FakeStore implements ReviewReworkStore {
  rows: ReworkCandidateRow[] = [];
  comments: Array<{ id: string; body: string; createdAt: Date }> = [];
  child: ReviewReworkChildFacts | null = null;
  created: CreateReworkTaskInput[] = [];
  blocked: Array<{ issueId: string; reworkIssueId: string; comment: string }> = [];
  unblocked: Array<{ issueId: string; comment: string }> = [];
  closed: Array<{ issueId: string; comment: string }> = [];
  stamped: Array<{ issueId: string; originFingerprint: string }> = [];
  reopened: Array<{ issueId: string; originFingerprint: string }> = [];
  deliveringAssignee: string | null = null;
  invokable = new Set<string>(["author-agent", "reviewer-agent"]);

  async listActiveCompanyIds() {
    return ["company-1"];
  }
  async listCandidateTasks() {
    return this.rows;
  }
  async listComments() {
    return this.comments;
  }
  async findReworkChild() {
    return this.child;
  }
  async deliveringTaskAssignee() {
    return this.deliveringAssignee;
  }
  async invokableAgentIds(_companyId: string, agentIds: readonly string[]) {
    return new Set(agentIds.filter((id) => this.invokable.has(id)));
  }
  async createReworkTask(input: CreateReworkTaskInput) {
    this.created.push(input);
    return { id: `rework-${this.created.length}`, identifier: `OPE-450${this.created.length}` };
  }
  async blockReviewTask(input: { issueId: string; reworkIssueId: string; comment: string }) {
    this.blocked.push(input);
    return true;
  }
  async unblockReviewTask(input: { issueId: string; comment: string }) {
    this.unblocked.push(input);
    return true;
  }
  async closeReviewTask(input: { issueId: string; comment: string }) {
    this.closed.push(input);
    return true;
  }
  async reopenedAfterLoopClose(_companyId: string, _issueId: string) {
    return false;
  }
  async applyGoalJudgeDecision(_input: {
    issueId: string;
    companyId: string;
    expectStatus: string;
    patch: Record<string, unknown>;
    comment: string | null;
  }) {
    // myrmidon(1.7-GOAL-JUDGE): this acceptance fixture covers the GitHub
    // rate-limit and budget paths; the judge is not wired here, so the
    // controller write path is never exercised by this store.
    return true;
  }
  async awaitAcceptance(_input: unknown) {
    return true;
  }
  async stampReworkFingerprint(input: { issueId: string; originFingerprint: string }) {
    this.stamped.push(input);
    return true;
  }
  async reopenReworkTask(input: { issueId: string; originFingerprint: string }) {
    this.reopened.push(input);
    return true;
  }
}

function buildSweep(depsInput: {
  store: FakeStore;
  resolvePr: ReviewReworkSweepDeps["resolvePr"];
}) {
  const deps: ReviewReworkSweepDeps = {
    store: depsInput.store,
    resolvePr: depsInput.resolvePr,
    readSettings: async () => ({
      enabled: true,
      sweepIntervalSec: DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC,
      fallbackAssigneeAgentId: null,
    }),
    enqueueWake: async () => {},
    logActivity: async () => {},
  };
  return createReviewReworkSweep(deps);
}

describe("OPE-12397 acceptance: GitHub rate limit and REVIEW-REWORK budget", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    resetGitHubObjectCacheForTests();
    resetGitHubRateLimitForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGitHubRateLimitForTests();
    resetGitHubObjectCacheForTests();
  });

  it("acceptance 1: on exhausted rate limit, background reads make zero HTTP calls", async () => {
    setGitHubRateLimitForTests(START_SEC + 3600, 0);

    const fetch = vi.fn(async () => pullResponse());
    const resolver = createPullRequestReviewFactsResolver({} as never, { fetch, tokenProvider: () => null, source: "review-rework" });

    // Directly calling the provider resolver when rate limited
    const facts = await resolver("company-1", { owner: "acme", repo: "repo", number: 484 });
    expect(facts).toEqual({
      state: "unknown",
      headSha: null,
      reviewDecision: null,
      updatedAt: null,
    });
    expect(fetch).not.toHaveBeenCalled();

    // Calling the review-rework background sweep when rate limited
    const store = new FakeStore();
    store.rows = [{
      task: reviewTask(),
      textParts: [reviewTask().title, ""],
      products: [{ repo: "acme/repo", number: 484, url: PR_URL, status: "active" }],
    }];
    store.comments = [{ id: "c-1", body: `VERDICT #484: RETURN (head ${HEAD_OLD})`, createdAt: new Date(START) }];

    const sweep = buildSweep({ store, resolvePr: resolver });
    const result = await sweep.sweep(new Date(START), { force: true });

    expect(result.skippedPass).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.created).toHaveLength(0);
  });

  it("acceptance 2: repeat resolve of the same PR inside TTL does not hit the network", async () => {
    const fetch = vi.fn(async () => pullResponse());
    const resolver = createPullRequestReviewFactsResolver({} as never, { fetch, tokenProvider: () => null, source: "review-rework" });

    const first = await resolver("company-1", { owner: "acme", repo: "repo", number: 484 });
    expect(first).toEqual({
      state: "open",
      headSha: HEAD_OLD,
      reviewDecision: null,
      updatedAt: "2026-11-09T00:00:00Z",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Advance 60s (inside default 120s TTL)
    at(60);
    const second = await resolver("company-1", { owner: "acme", repo: "repo", number: 484 });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("acceptance 3: expired entry sends If-None-Match and replays 304 snapshot", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (sentIfNoneMatch(init) === '"v1"') {
        return notModified();
      }
      return pullResponse({}, '"v1"');
    });
    const resolver = createPullRequestReviewFactsResolver({} as never, { fetch, tokenProvider: () => null, source: "review-rework" });

    const first = await resolver("company-1", { owner: "acme", repo: "repo", number: 484 });
    expect(first.state).toBe("open");
    expect(fetch).toHaveBeenCalledTimes(1);

    // Advance 125s (beyond 120s TTL)
    at(125);
    const second = await resolver("company-1", { owner: "acme", repo: "repo", number: 484 });
    expect(fetch).toHaveBeenCalledTimes(2);

    // Assert If-None-Match header was sent on the second request
    const secondCallHeaders = (fetch.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(secondCallHeaders["if-none-match"]).toBe('"v1"');
    expect(second).toEqual(first);
  });

  it("acceptance 4: REVIEW-REWORK reads each PR at most once per pass and evaluates every candidate task", async () => {
    const fetch = vi.fn(async () => pullResponse());
    const resolver = createPullRequestReviewFactsResolver({} as never, { fetch, tokenProvider: () => null, source: "review-rework" });

    const store = new FakeStore();
    const task1 = reviewTask({ id: "review-1", identifier: "OPE-4417" });
    const task2 = reviewTask({ id: "review-2", identifier: "OPE-4418" });
    store.rows = [
      { task: task1, textParts: [task1.title, ""], products: [{ repo: "acme/repo", number: 484, url: PR_URL, status: "active" }] },
      { task: task2, textParts: [task2.title, ""], products: [{ repo: "acme/repo", number: 484, url: PR_URL, status: "active" }] },
    ];
    store.comments = [{ id: "c-1", body: `VERDICT #484: RETURN (head ${HEAD_OLD})`, createdAt: new Date(START) }];

    const sweep = buildSweep({ store, resolvePr: resolver });
    const result = await sweep.sweep(new Date(START), { force: true });

    // Only 1 HTTP call made for the shared PR
    expect(fetch).toHaveBeenCalledTimes(1);

    // Both candidate tasks evaluated and acted upon
    expect(result.reworkCreated).toBe(2);
    expect(result.blocked).toBe(2);
    expect(store.created).toHaveLength(2);
    expect(store.blocked).toHaveLength(2);
  });

  it("acceptance 5: provider requests record against the review-rework source bucket", async () => {
    const fetch = vi.fn(async () => pullResponse({}, '"v1"', { "x-ratelimit-remaining": "4990" }));
    const resolver = createPullRequestReviewFactsResolver({} as never, { fetch, tokenProvider: () => null, source: "review-rework" });

    await resolver("company-1", { owner: "acme", repo: "repo", number: 484 });

    const metrics = getGitHubRateLimitMetrics();
    expect(metrics.sources["review-rework"]).toBeGreaterThanOrEqual(1);
  });
});
