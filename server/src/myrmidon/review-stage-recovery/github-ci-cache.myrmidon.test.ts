// myrmidon(OPE-12397): the read cache of the review-stage CI reads. The stranded-issue sweep asks
// for the CI of every review stage with an open PR on each heartbeat tick, and every ask was 2-4
// GETs that nothing remembered. Now the head of a PR is served from memory for a short TTL, the
// verdict of a head for the same TTL (or a long one once the CI of the head is complete), reads
// that run at the same time share one request, an error is never stored, and nothing is sent to
// GitHub while the shared rate-limit state says the budget is gone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGitHubRateLimitForTests, setGitHubRateLimitForTests } from "../../services/github-rate-limit.js";
import {
  REVIEW_CI_CACHE_MAX_ENTRIES,
  createReviewPullRequestCiResolver,
  resetReviewCiCacheForTests,
  resolvePullRequestHeadCi,
  resolvePullRequestHeadFailedChecks,
} from "./github-ci.js";

const START = Date.parse("2026-11-08T00:00:00Z");
const START_SEC = Math.floor(START / 1000);
const PULL_TTL_ENV = "MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC";
const COMPLETE_TTL_ENV = "MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC";

/** Moves the clock to `seconds` after the start of the test. */
function at(seconds: number) {
  vi.setSystemTime(START + seconds * 1000);
}

function reference(number: number) {
  return { host: "github.com" as const, owner: "acme", repo: "app", number };
}

const WORKFLOWS = "/repos/acme/app/contents/.github/workflows";

function pullPath(number: number) {
  return `/repos/acme/app/pulls/${number}`;
}

function finalCheckPath(sha: string) {
  return `/repos/acme/app/commits/${sha}/check-runs?check_name=CI%20result&filter=all&per_page=100`;
}

function latestChecksPath(sha: string) {
  return `/repos/acme/app/commits/${sha}/check-runs?filter=latest&per_page=100`;
}

type Handler = () => Response | Promise<Response>;

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** A fake GitHub: `routes` answer by path; the workflows listing has a workflow unless a route says otherwise. */
function githubFetch(routes: Record<string, Handler>) {
  return vi.fn(async (url: string) => {
    const path = url.replace("https://api.github.com", "");
    const handler = routes[path] ?? (path === WORKFLOWS ? () => json([{ name: "ci.yml" }]) : undefined);
    return handler ? handler() : new Response("not found", { status: 404 });
  });
}

type GithubFetch = ReturnType<typeof githubFetch>;

function paths(fetch: GithubFetch) {
  return fetch.mock.calls.map(([url]) => url.replace("https://api.github.com", ""));
}

function openPull(sha: string): Handler {
  return () => json({ state: "open", head: { sha } });
}

const completedFinalCheck: Handler = () =>
  json({ check_runs: [{ name: "CI result", status: "completed", conclusion: "success" }] });
const queuedFinalCheck: Handler = () =>
  json({ check_runs: [{ name: "CI result", status: "queued", conclusion: null }] });

/** A PR whose head `abc123` has a finished CI. */
function completeGithub() {
  return githubFetch({ [pullPath(7)]: openPull("abc123"), [finalCheckPath("abc123")]: completedFinalCheck });
}

function readCi(fetch: GithubFetch, number = 7, token: string | null = "token") {
  return resolvePullRequestHeadCi({ reference: reference(number), token, fetch });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.stubEnv(PULL_TTL_ENV, "");
  vi.stubEnv(COMPLETE_TTL_ENV, "");
  resetReviewCiCacheForTests();
  resetGitHubRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetGitHubRateLimitForTests();
  resetReviewCiCacheForTests();
});

describe("resolvePullRequestHeadCi: read cache", () => {
  it("serves a repeated read inside the TTL without a request", async () => {
    const fetch = completeGithub();

    const first = await readCi(fetch);
    at(59);
    const second = await readCi(fetch);

    // myrmidon(OPE-12176): the verdict of the finished final check travels with
    // the complete state, and the cache serves the same object back.
    expect(first).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: "success" });
    expect(second).toEqual(first);
    expect(paths(fetch)).toEqual([pullPath(7), WORKFLOWS, finalCheckPath("abc123")]);
  });

  it("keeps a complete CI for the long TTL and asks only for the head in between", async () => {
    const fetch = completeGithub();

    await readCi(fetch);
    at(61);
    await readCi(fetch);
    expect(paths(fetch).slice(3)).toEqual([pullPath(7)]);

    at(599);
    await readCi(fetch);
    expect(paths(fetch).slice(4)).toEqual([pullPath(7)]);

    at(601);
    await readCi(fetch);
    expect(paths(fetch).slice(5)).toEqual([WORKFLOWS, finalCheckPath("abc123")]);
  });

  it("keeps a pending CI only as long as the head, and sees it finish", async () => {
    let finished = false;
    const fetch = githubFetch({
      [pullPath(8)]: openPull("def456"),
      [finalCheckPath("def456")]: () => (finished ? completedFinalCheck() : queuedFinalCheck()),
    });

    const pending = await readCi(fetch, 8);
    at(59);
    await readCi(fetch, 8);
    expect(paths(fetch)).toHaveLength(3);

    finished = true;
    at(61);
    const complete = await readCi(fetch, 8);

    expect(pending).toEqual({ state: "pending", headSha: "def456" });
    // myrmidon(OPE-12176): the verdict travels with the complete state, cached
    // under the long complete TTL with it.
    expect(complete).toEqual({ state: "complete", headSha: "def456", finalCheckConclusion: "success" });
    expect(paths(fetch)).toHaveLength(6);
  });

  it("keeps the verdict of a repository without the aggregate check, read from all of its checks", async () => {
    const fetch = githubFetch({
      [pullPath(7)]: openPull("abc123"),
      [finalCheckPath("abc123")]: () => json({ check_runs: [] }),
      [latestChecksPath("abc123")]: () =>
        json({ total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }),
    });

    const first = await readCi(fetch);
    at(120);
    const second = await readCi(fetch);

    expect(first).toEqual({ state: "complete", headSha: "abc123" });
    expect(second).toEqual(first);
    expect(paths(fetch)).toEqual([
      pullPath(7),
      WORKFLOWS,
      finalCheckPath("abc123"),
      latestChecksPath("abc123"),
      pullPath(7),
    ]);
  });

  it("keeps the answer for a repository without workflows for the short TTL", async () => {
    const fetch = githubFetch({ [pullPath(7)]: openPull("abc123"), [WORKFLOWS]: () => new Response("", { status: 404 }) });

    const first = await readCi(fetch);
    const calls = fetch.mock.calls.length;
    at(59);
    const second = await readCi(fetch);

    expect(first).toEqual({ state: "not_configured", headSha: "abc123" });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("keeps a merged or closed pull request as the head TTL says", async () => {
    const fetch = githubFetch({ [pullPath(7)]: () => json({ state: "closed", merged: true, head: { sha: "abc123" } }) });

    const first = await readCi(fetch);
    at(59);
    await readCi(fetch);
    at(61);
    await readCi(fetch);

    expect(first).toEqual({ state: "no_pull_request", headSha: "abc123" });
    expect(paths(fetch)).toEqual([pullPath(7), pullPath(7)]);
  });

  it("does not store a failed head read: the next read goes to GitHub again", async () => {
    let healthy = false;
    const fetch = githubFetch({
      [pullPath(7)]: () => (healthy ? openPull("abc123")() : new Response("{}", { status: 500 })),
      [finalCheckPath("abc123")]: completedFinalCheck,
    });

    const failed = await readCi(fetch);
    healthy = true;
    const recovered = await readCi(fetch);
    const remembered = await readCi(fetch);

    expect(failed).toEqual({ state: "unknown", headSha: null, reason: "pull:http_500" });
    expect(recovered).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: "success" });
    expect(remembered).toEqual(recovered);
    expect(paths(fetch)).toEqual([pullPath(7), pullPath(7), WORKFLOWS, finalCheckPath("abc123")]);
  });

  it("does not store a failed check read, but keeps the head it was asked for", async () => {
    let healthy = false;
    const fetch = githubFetch({
      [pullPath(7)]: openPull("abc123"),
      [finalCheckPath("abc123")]: () => (healthy ? completedFinalCheck() : new Response("{}", { status: 500 })),
    });

    const failed = await readCi(fetch);
    healthy = true;
    const recovered = await readCi(fetch);

    expect(failed).toEqual({ state: "unknown", headSha: "abc123", reason: "check_runs:http_500" });
    expect(recovered).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: "success" });
    expect(paths(fetch)).toEqual([pullPath(7), WORKFLOWS, finalCheckPath("abc123"), WORKFLOWS, finalCheckPath("abc123")]);
  });

  it("does not store a payload it cannot read", async () => {
    let readable = false;
    const fetch = githubFetch({
      [pullPath(7)]: openPull("abc123"),
      [finalCheckPath("abc123")]: () => (readable ? completedFinalCheck() : json({ check_runs: "nope" })),
    });

    const broken = await readCi(fetch);
    readable = true;
    const fixed = await readCi(fetch);

    expect(broken).toEqual({ state: "unknown", headSha: "abc123", reason: "check_runs:unreadable_payload" });
    expect(fixed).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: "success" });
  });

  it("sends one request for reads of one head that run at the same time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = githubFetch({
      [pullPath(7)]: async () => {
        await gate;
        return openPull("abc123")();
      },
      [finalCheckPath("abc123")]: completedFinalCheck,
    });

    const reads = [readCi(fetch), readCi(fetch), readCi(fetch)];
    release();
    const results = await Promise.all(reads);

    expect(results).toEqual([
      { state: "complete", headSha: "abc123", finalCheckConclusion: "success" },
      { state: "complete", headSha: "abc123", finalCheckConclusion: "success" },
      { state: "complete", headSha: "abc123", finalCheckConclusion: "success" },
    ]);
    expect(paths(fetch)).toEqual([pullPath(7), WORKFLOWS, finalCheckPath("abc123")]);
  });

  it("does not merge reads of different pull requests", async () => {
    const fetch = githubFetch({
      [pullPath(7)]: openPull("abc123"),
      [pullPath(8)]: openPull("def456"),
      [finalCheckPath("abc123")]: completedFinalCheck,
      [finalCheckPath("def456")]: queuedFinalCheck,
    });

    const [one, two] = await Promise.all([readCi(fetch, 7), readCi(fetch, 8)]);

    // myrmidon(OPE-12176): the verdict belongs to its own pull request's read;
    // the other head stays pending with no verdict of its own.
    expect(one).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: "success" });
    expect(two).toEqual({ state: "pending", headSha: "def456" });
    expect(paths(fetch).filter((path) => path.startsWith("/repos/acme/app/pulls/"))).toHaveLength(2);
  });

  it("does not serve a read made with one token to a caller with another", async () => {
    const fetch = completeGithub();

    await readCi(fetch, 7, "token-a");
    await readCi(fetch, 7, "token-b");
    await readCi(fetch, 7, null);
    await readCi(fetch, 7, "token-a");

    expect(paths(fetch).filter((path) => path === pullPath(7))).toHaveLength(3);
  });

  it("takes both TTLs from the environment", async () => {
    vi.stubEnv(PULL_TTL_ENV, "10");
    vi.stubEnv(COMPLETE_TTL_ENV, "100");
    const fetch = completeGithub();

    await readCi(fetch);
    at(11);
    await readCi(fetch);
    expect(paths(fetch).slice(3)).toEqual([pullPath(7)]);

    at(99);
    await readCi(fetch);
    expect(paths(fetch).slice(4)).toEqual([pullPath(7)]);

    at(101);
    await readCi(fetch);
    expect(paths(fetch).slice(5)).toEqual([WORKFLOWS, finalCheckPath("abc123")]);
  });

  it.each(["abc", "-5", "1.5", "  "])("falls back to the defaults for %j", async (value) => {
    vi.stubEnv(PULL_TTL_ENV, value);
    vi.stubEnv(COMPLETE_TTL_ENV, value);
    const fetch = completeGithub();

    await readCi(fetch);
    at(59);
    await readCi(fetch);

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("is off when both TTLs are 0: every read goes to GitHub and none is shared", async () => {
    vi.stubEnv(PULL_TTL_ENV, "0");
    vi.stubEnv(COMPLETE_TTL_ENV, "0");
    const fetch = completeGithub();

    await readCi(fetch);
    await readCi(fetch);
    expect(fetch).toHaveBeenCalledTimes(6);

    await Promise.all([readCi(fetch), readCi(fetch)]);
    expect(fetch).toHaveBeenCalledTimes(12);
  });

  it("remembers only the complete verdicts when the head TTL is 0", async () => {
    vi.stubEnv(PULL_TTL_ENV, "0");
    const fetch = completeGithub();

    await readCi(fetch);
    await readCi(fetch);

    expect(paths(fetch)).toEqual([pullPath(7), WORKFLOWS, finalCheckPath("abc123"), pullPath(7)]);
  });
});

describe("resolvePullRequestHeadCi: rate limit", () => {
  const limited = { remaining: 0, limit: null, resetEpochSeconds: START_SEC + 600 };

  function exhaust(untilSeconds = 600) {
    setGitHubRateLimitForTests(START_SEC + untilSeconds, 0);
  }

  it("sends nothing while the budget is gone and nothing is remembered, and says when to come back", async () => {
    exhaust();
    const fetch = completeGithub();

    const authenticated = await readCi(fetch);
    const anonymous = await readCi(fetch, 7, null);

    expect(authenticated).toEqual({
      state: "unknown",
      headSha: null,
      reason: "pull:skipped_rate_limited",
      rateLimit: limited,
    });
    expect(anonymous).toMatchObject({ state: "unknown", reason: "pull:skipped_rate_limited (anonymous)", rateLimit: limited });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends nothing with the cache off either", async () => {
    vi.stubEnv(PULL_TTL_ENV, "0");
    vi.stubEnv(COMPLETE_TTL_ENV, "0");
    exhaust();
    const fetch = completeGithub();

    const result = await readCi(fetch);

    expect(result).toMatchObject({ state: "unknown", reason: "pull:skipped_rate_limited", rateLimit: limited });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the remembered result, even an expired one, and refuses a head it never read", async () => {
    const fetch = completeGithub();
    const remembered = await readCi(fetch);

    at(700);
    exhaust(1500);
    const stale = await readCi(fetch);
    const unseen = await readCi(fetch, 8);

    expect(stale).toEqual(remembered);
    expect(unseen).toMatchObject({ state: "unknown", reason: "pull:skipped_rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("goes back to GitHub once the window has passed", async () => {
    const fetch = completeGithub();
    await readCi(fetch);

    at(700);
    exhaust(1500);
    await readCi(fetch);
    expect(fetch).toHaveBeenCalledTimes(3);

    at(1501);
    const result = await readCi(fetch);

    expect(result).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: "success" });
    expect(paths(fetch).slice(3)).toEqual([pullPath(7), WORKFLOWS, finalCheckPath("abc123")]);
  });

  it("stops the rest of a read once an answer of GitHub says the budget is gone", async () => {
    const fetch = githubFetch({
      [pullPath(7)]: () =>
        json(
          { state: "open", head: { sha: "abc123" } },
          { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(START_SEC + 900) } },
        ),
    });

    const result = await readCi(fetch);

    expect(result).toEqual({
      state: "unknown",
      headSha: "abc123",
      reason: "check_runs:skipped_rate_limited",
      rateLimit: { remaining: 0, limit: 5000, resetEpochSeconds: START_SEC + 900 },
    });
    expect(paths(fetch)).toEqual([pullPath(7)]);
  });

  it("serves a fresh result whether or not the budget is gone", async () => {
    const fetch = completeGithub();
    const remembered = await readCi(fetch);

    exhaust();

    expect(await readCi(fetch)).toEqual(remembered);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("createReviewPullRequestCiResolver: read cache", () => {
  function fakeDb(rows: unknown[]) {
    return {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as never;
  }

  const openProduct = {
    id: "wp-1",
    type: "pull_request",
    status: "open",
    url: "https://github.com/acme/app/pull/7",
    metadata: null,
    isPrimary: true,
    updatedAt: new Date(),
  };

  it("serves the next sweep of the same review stage from memory", async () => {
    const fetch = completeGithub();
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => "token",
      fetch,
    });

    const first = await resolver({ companyId: "company-1", issueId: "issue-1" });
    at(30);
    const second = await resolver({ companyId: "company-1", issueId: "issue-1" });

    expect(first).toEqual({ state: "complete", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "abc123", finalCheckConclusion: "success" });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("hands the reason and the time to come back to the recovery while the budget is gone", async () => {
    setGitHubRateLimitForTests(START_SEC + 600, 0);
    const fetch = completeGithub();
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => "token",
      fetch,
    });

    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "unknown",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: null,
      reason: "pull:skipped_rate_limited",
      rateLimit: { remaining: 0, limit: null, resetEpochSeconds: START_SEC + 600 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("resolvePullRequestHeadFailedChecks: read cache", () => {
  const finishedRuns = {
    total_count: 2,
    check_runs: [
      { name: "CI result", status: "completed", conclusion: "failure" },
      { name: "build", status: "completed", conclusion: "success" },
    ],
  };
  const runningRuns = {
    total_count: 2,
    check_runs: [
      { name: "CI result", status: "in_progress", conclusion: null },
      { name: "tests", status: "completed", conclusion: "failure" },
    ],
  };

  function readFailed(fetch: GithubFetch, headSha = "abc123", token: string | null = "token") {
    return resolvePullRequestHeadFailedChecks({ reference: reference(7), token, headSha, fetch });
  }

  it("serves a repeated read inside the TTL without a request, as a copy", async () => {
    const fetch = githubFetch({ [latestChecksPath("abc123")]: () => json(finishedRuns) });

    const first = await readFailed(fetch);
    if (first.state === "ok") first.failed.push("tampered");
    at(59);
    const second = await readFailed(fetch);

    expect(second).toEqual({ state: "ok", failed: ["CI result"] });
    expect(paths(fetch)).toEqual([latestChecksPath("abc123")]);
  });

  it("keeps a list of finished checks for the long TTL and a list with a running check for the short one", async () => {
    const fetch = githubFetch({
      [latestChecksPath("aaa111")]: () => json(finishedRuns),
      [latestChecksPath("bbb222")]: () => json(runningRuns),
    });

    await readFailed(fetch, "aaa111");
    await readFailed(fetch, "bbb222");
    at(61);
    await readFailed(fetch, "aaa111");
    await readFailed(fetch, "bbb222");
    expect(paths(fetch).slice(2)).toEqual([latestChecksPath("bbb222")]);

    at(601);
    await readFailed(fetch, "aaa111");
    await readFailed(fetch, "bbb222");
    expect(paths(fetch).slice(3)).toEqual([latestChecksPath("aaa111"), latestChecksPath("bbb222")]);
  });

  it("does not store an error", async () => {
    let healthy = false;
    const fetch = githubFetch({
      [latestChecksPath("abc123")]: () => (healthy ? json(finishedRuns) : new Response("{}", { status: 500 })),
    });

    const failed = await readFailed(fetch);
    healthy = true;
    const recovered = await readFailed(fetch);
    await readFailed(fetch);

    expect(failed).toEqual({ state: "unknown", reason: "check_runs:http_500" });
    expect(recovered).toEqual({ state: "ok", failed: ["CI result"] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends one request for reads of one head that run at the same time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = githubFetch({
      [latestChecksPath("abc123")]: async () => {
        await gate;
        return json(finishedRuns);
      },
    });

    const reads = [readFailed(fetch), readFailed(fetch)];
    release();
    const results = await Promise.all(reads);

    expect(results).toEqual([
      { state: "ok", failed: ["CI result"] },
      { state: "ok", failed: ["CI result"] },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing while the budget is gone and returns the remembered list, even an expired one", async () => {
    const fetch = githubFetch({ [latestChecksPath("abc123")]: () => json(finishedRuns) });
    const remembered = await readFailed(fetch);

    at(700);
    setGitHubRateLimitForTests(START_SEC + 1500, 0);
    const stale = await readFailed(fetch);
    const unseen = await readFailed(fetch, "def456");

    expect(stale).toEqual(remembered);
    expect(unseen).toEqual({ state: "unknown", reason: "check_runs:skipped_rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing while the budget is gone with the cache off", async () => {
    vi.stubEnv(PULL_TTL_ENV, "0");
    vi.stubEnv(COMPLETE_TTL_ENV, "0");
    setGitHubRateLimitForTests(START_SEC + 600, 0);
    const fetch = githubFetch({ [latestChecksPath("abc123")]: () => json(finishedRuns) });

    expect(await readFailed(fetch)).toEqual({ state: "unknown", reason: "check_runs:skipped_rate_limited" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("holds at most REVIEW_CI_CACHE_MAX_ENTRIES reads, the oldest leave first", async () => {
    const everyHead = vi.fn(async () =>
      json({ total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }),
    );

    for (let number = 1; number <= REVIEW_CI_CACHE_MAX_ENTRIES + 1; number += 1) {
      await resolvePullRequestHeadFailedChecks({ reference: reference(7), token: "token", headSha: `sha-${number}`, fetch: everyHead });
    }
    const filled = everyHead.mock.calls.length;

    await resolvePullRequestHeadFailedChecks({
      reference: reference(7),
      token: "token",
      headSha: `sha-${REVIEW_CI_CACHE_MAX_ENTRIES + 1}`,
      fetch: everyHead,
    });
    expect(everyHead).toHaveBeenCalledTimes(filled);

    await resolvePullRequestHeadFailedChecks({ reference: reference(7), token: "token", headSha: "sha-1", fetch: everyHead });
    expect(everyHead).toHaveBeenCalledTimes(filled + 1);
  });
});
