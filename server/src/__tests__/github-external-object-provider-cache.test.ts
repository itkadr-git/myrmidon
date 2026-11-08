// myrmidon(OPE-12397): the read cache of the GitHub external object provider.
// Every caller used to pay a full GET 200 per read; now an object is served from
// memory inside its TTL, re-read conditionally after it, shared between parallel
// reads, not asked at all while the rate limit is exhausted, and dropped when the
// board merges the pull request itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_OBJECT_CACHE_MAX_ENTRIES,
  createGitHubExternalObjectProvider,
  invalidateGitHubPullRequestCache,
  resetGitHubObjectCacheForTests,
} from "../services/github-external-object-provider.js";
import { resetGitHubRateLimitForTests, setGitHubRateLimitForTests } from "../services/github-rate-limit.js";
import { createGitHubBoardMergeClient } from "../myrmidon/review-routing/github-board-merge.js";

const COMPANY = "company-1";
const START = Date.parse("2026-11-08T00:00:00Z");
const START_SEC = Math.floor(START / 1000);
const TTL_ENV = "MYRMIDON_GITHUB_OBJECT_CACHE_TTL_SEC";
const TERMINAL_TTL_ENV = "MYRMIDON_GITHUB_OBJECT_TERMINAL_TTL_SEC";

/** Moves the clock to `seconds` after the start of the test. */
function at(seconds: number) {
  vi.setSystemTime(START + seconds * 1000);
}

function pullBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Ship it",
    state: "open",
    draft: false,
    merged: false,
    updated_at: "2026-11-08T00:00:00Z",
    head: { ref: "feature", sha: "abc123" },
    base: { ref: "main", repo: { default_branch: "main" } },
    ...overrides,
  };
}

const MERGED = { state: "closed", merged: true, merged_at: "2026-11-08T00:00:00Z", merge_commit_sha: "m1" };
const CLOSED = { state: "closed", merged: false };

function pullResponse(overrides: Record<string, unknown> = {}, etag = '"v1"', headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(pullBody(overrides)), {
    status: 200,
    headers: { "content-type": "application/json", etag, ...headers },
  });
}

function notModified() {
  return new Response(null, { status: 304 });
}

function notFound() {
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
}

type MockFetch = ReturnType<typeof mockFetch>;

/** The headers of the n-th request (0-based). */
function sentHeaders(fetch: MockFetch, index: number) {
  return (fetch.mock.calls[index]![1] as RequestInit).headers as Record<string, string>;
}

function urls(fetch: MockFetch) {
  return fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

function sentIfNoneMatch(init?: RequestInit) {
  return (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
}

function resolverFor(
  fetch: MockFetch,
  objectType: "pull_request" | "issue" = "pull_request",
  tokenProvider: () => string | null = () => null,
) {
  const provider = createGitHubExternalObjectProvider({} as never, { fetch, tokenProvider });
  return provider.resolvers.find((entry) => entry.objectType === objectType)!;
}

function prObject(number = 42, repository = "acme/app", extra: Record<string, unknown> = {}) {
  return {
    externalId: `${repository}#pull/${number}`,
    sanitizedCanonicalUrl: `https://github.com/${repository}/pull/${number}`,
    ...extra,
  } as never;
}

function issueObject(number = 42) {
  return {
    externalId: `acme/app#issues/${number}`,
    sanitizedCanonicalUrl: `https://github.com/acme/app/issues/${number}`,
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.stubEnv(TTL_ENV, "");
  vi.stubEnv(TERMINAL_TTL_ENV, "");
  resetGitHubObjectCacheForTests();
  resetGitHubRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetGitHubRateLimitForTests();
  resetGitHubObjectCacheForTests();
});

describe("GitHub external object provider: read cache", () => {
  it("serves a repeated read inside the TTL without a request", async () => {
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);

    const first = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(119);
    const second = await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ ok: true, snapshot: expect.objectContaining({ statusKey: "open", etag: '"v1"' }) });
    expect(second).toEqual(first);
  });

  it("shares the cache between providers and keeps issues and pull requests apart", async () => {
    const fetch = mockFetch((url) => (url.includes("/issues/") ? new Response(JSON.stringify({ state: "open", title: "Bug" }), { status: 200, headers: { etag: '"i1"' } }) : pullResponse()));

    await resolverFor(fetch).resolve({ companyId: COMPANY, object: prObject() });
    await resolverFor(fetch).resolve({ companyId: COMPANY, object: prObject() });
    expect(urls(fetch)).toEqual(["/repos/acme/app/pulls/42"]);

    await resolverFor(fetch, "issue").resolve({ companyId: COMPANY, object: issueObject() });
    await resolverFor(fetch, "issue").resolve({ companyId: COMPANY, object: issueObject() });
    expect(urls(fetch)).toEqual(["/repos/acme/app/pulls/42", "/repos/acme/app/issues/42"]);
  });

  it("does not serve one company's read to another", async () => {
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);

    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    await resolver.resolve({ companyId: "company-2", object: prObject() });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-reads conditionally after the TTL and a 304 returns the cached snapshot", async () => {
    const fetch = mockFetch((_url, init) => (sentIfNoneMatch(init) ? notModified() : pullResponse()));
    const resolver = resolverFor(fetch);

    const first = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(121);
    const second = await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentHeaders(fetch, 0)).not.toHaveProperty("if-none-match");
    expect(sentHeaders(fetch, 1)).toMatchObject({ "if-none-match": '"v1"' });
    expect(second).toEqual(first);

    // The 304 renewed the entry: no request for another TTL, then one more conditional read.
    at(121 + 119);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    expect(fetch).toHaveBeenCalledTimes(2);
    at(121 + 121);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("replaces the entry when GitHub answers 200 after the TTL and uses the new etag next", async () => {
    const answers = [
      () => pullResponse({ title: "Ship it" }, '"v1"'),
      () => pullResponse({ title: "Ship it now" }, '"v2"'),
      () => notModified(),
    ];
    const fetch = mockFetch(() => answers.shift()!());
    const resolver = resolverFor(fetch);

    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(121);
    const changed = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(300);
    const replayed = await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(changed).toEqual({ ok: true, snapshot: expect.objectContaining({ displayTitle: "acme/app#42: Ship it now", etag: '"v2"' }) });
    expect(sentHeaders(fetch, 2)).toMatchObject({ "if-none-match": '"v2"' });
    expect(replayed).toEqual(changed);
  });

  it("does not cache a failed read", async () => {
    const answers = [
      () => { throw new Error("offline"); },
      () => pullResponse(),
    ];
    const fetch = mockFetch(() => answers.shift()!());
    const resolver = resolverFor(fetch);

    const failed = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    const retried = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(failed).toMatchObject({ ok: false, errorCode: "github_fetch_failed" });
    expect(retried.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps answering with the etag a caller holds, and caches the answer", async () => {
    const fetch = mockFetch((_url, init) => (sentIfNoneMatch(init) === '"db-1"' ? notModified() : pullResponse()));
    const resolver = resolverFor(fetch);
    const held = prObject(42, "acme/app", {
      displayKey: "GitHub Pull Request",
      displayTitle: "acme/app#42: From the board",
      statusKey: "open",
      statusLabel: "Open",
      statusCategory: "open",
      statusTone: "info",
      isTerminal: false,
      data: { provider: "github", state: "open" },
      remoteVersion: "2026-11-07T00:00:00Z",
      etag: '"db-1"',
    });

    const result = await resolver.resolve({ companyId: COMPANY, object: held });
    await resolver.resolve({ companyId: COMPANY, object: held });

    expect(sentHeaders(fetch, 0)).toMatchObject({ "if-none-match": '"db-1"' });
    expect(result).toEqual({
      ok: true,
      snapshot: expect.objectContaining({ displayTitle: "acme/app#42: From the board", etag: '"db-1"', data: { provider: "github", state: "open" } }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves an invalid identity to the old answer, without a request", async () => {
    const fetch = mockFetch(() => pullResponse());
    const result = await resolverFor(fetch).resolve({ companyId: COMPANY, object: { externalId: "nonsense", sanitizedCanonicalUrl: null } as never });

    expect(result).toMatchObject({ ok: false, errorCode: "github_invalid_identity" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GitHub external object provider: terminal objects", () => {
  it.each([
    ["merged", MERGED],
    ["closed", CLOSED],
  ])("keeps a %s pull request longer than an open one", async (_name, state) => {
    const fetch = mockFetch((_url, init) => (sentIfNoneMatch(init) ? notModified() : pullResponse(state)));
    const resolver = resolverFor(fetch);

    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(1799);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    expect(fetch).toHaveBeenCalledTimes(1);

    at(1801);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentHeaders(fetch, 1)).toMatchObject({ "if-none-match": '"v1"' });
  });

  it("keeps a pull request that is not found, when the read carried a token", async () => {
    const fetch = mockFetch(() => notFound());
    const resolver = resolverFor(fetch, "pull_request", () => "ghp_token");

    const first = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(1799);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(first).toEqual({ ok: true, snapshot: expect.objectContaining({ statusKey: "not_found", data: expect.objectContaining({ authenticated: true }) }) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again soon after an anonymous 404: a missing token is not a missing pull request", async () => {
    const fetch = mockFetch(() => notFound());
    const resolver = resolverFor(fetch);

    const first = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(121);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(first).toEqual({ ok: true, snapshot: expect.objectContaining({ data: expect.objectContaining({ notFound: true, authenticated: false }) }) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("takes both TTLs from the environment", async () => {
    vi.stubEnv(TTL_ENV, "10");
    vi.stubEnv(TERMINAL_TTL_ENV, "60");
    const fetch = mockFetch((url) => pullResponse(url.endsWith("/43") ? MERGED : {}));
    const resolver = resolverFor(fetch);

    await resolver.resolve({ companyId: COMPANY, object: prObject(42) });
    await resolver.resolve({ companyId: COMPANY, object: prObject(43) });
    at(9);
    await resolver.resolve({ companyId: COMPANY, object: prObject(42) });
    await resolver.resolve({ companyId: COMPANY, object: prObject(43) });
    expect(fetch).toHaveBeenCalledTimes(2);

    at(11);
    await resolver.resolve({ companyId: COMPANY, object: prObject(42) });
    await resolver.resolve({ companyId: COMPANY, object: prObject(43) });
    expect(urls(fetch).slice(2)).toEqual(["/repos/acme/app/pulls/42"]);

    at(61);
    await resolver.resolve({ companyId: COMPANY, object: prObject(43) });
    expect(urls(fetch).slice(3)).toEqual(["/repos/acme/app/pulls/43"]);
  });
});

describe("GitHub external object provider: cache switch", () => {
  it("is off at 0: every read goes to GitHub", async () => {
    vi.stubEnv(TTL_ENV, "0");
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);

    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentHeaders(fetch, 1)).not.toHaveProperty("if-none-match");
  });

  it.each(["abc", "-5", "1.5", "  "])("falls back to the default for %j", async (value) => {
    vi.stubEnv(TTL_ENV, value);
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);

    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(119);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds at most GITHUB_OBJECT_CACHE_MAX_ENTRIES objects, the oldest leaves first", async () => {
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);

    for (let number = 1; number <= GITHUB_OBJECT_CACHE_MAX_ENTRIES + 1; number += 1) {
      await resolver.resolve({ companyId: COMPANY, object: prObject(number) });
    }
    const filled = fetch.mock.calls.length;
    await resolver.resolve({ companyId: COMPANY, object: prObject(GITHUB_OBJECT_CACHE_MAX_ENTRIES + 1) });
    expect(fetch).toHaveBeenCalledTimes(filled);

    await resolver.resolve({ companyId: COMPANY, object: prObject(1) });
    expect(fetch).toHaveBeenCalledTimes(filled + 1);
  });
});

describe("GitHub external object provider: parallel reads", () => {
  it("sends one request for reads of one object that run at the same time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = mockFetch(async () => {
      await gate;
      return pullResponse();
    });
    const [one, two] = [resolverFor(fetch), resolverFor(fetch)];

    const reads = [
      one.resolve({ companyId: COMPANY, object: prObject() }),
      one.resolve({ companyId: COMPANY, object: prObject() }),
      two.resolve({ companyId: COMPANY, object: prObject() }),
    ];
    release();
    const results = await Promise.all(reads);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("does not merge reads of different objects", async () => {
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);

    await Promise.all([
      resolver.resolve({ companyId: COMPANY, object: prObject(42) }),
      resolver.resolve({ companyId: COMPANY, object: prObject(43) }),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub external object provider: merge commit reachability (/compare)", () => {
  const stacked = { ...MERGED, base: { ref: "feature/stack", repo: { default_branch: "main" } } };

  function stackedFetch(compare: Record<string, unknown>) {
    return mockFetch((url, init) => {
      if (url.includes("/compare/")) return new Response(JSON.stringify(compare), { status: 200 });
      return sentIfNoneMatch(init) ? notModified() : pullResponse(stacked);
    });
  }

  it("keeps the /compare verdict with the pull request: one pair of requests, then the cache", async () => {
    const fetch = stackedFetch({ status: "behind", ahead_by: 0 });
    const resolver = resolverFor(fetch);

    const first = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(1000);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(first).toEqual({ ok: true, snapshot: expect.objectContaining({ data: expect.objectContaining({ mergeCommitReachable: true }) }) });
    expect(urls(fetch)).toEqual(["/repos/acme/app/pulls/42", "/repos/acme/app/compare/main...m1"]);
  });

  it("asks both again, unconditionally, while the merge commit is not on the default branch", async () => {
    const fetch = stackedFetch({ status: "ahead", ahead_by: 3 });
    const resolver = resolverFor(fetch);

    const first = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    at(121);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(first).toEqual({ ok: true, snapshot: expect.objectContaining({ data: expect.objectContaining({ mergeCommitReachable: false }) }) });
    expect(urls(fetch)).toEqual([
      "/repos/acme/app/pulls/42",
      "/repos/acme/app/compare/main...m1",
      "/repos/acme/app/pulls/42",
      "/repos/acme/app/compare/main...m1",
    ]);
    expect(sentHeaders(fetch, 2)).not.toHaveProperty("if-none-match");
  });

  it("does not ask /compare once the budget is gone", async () => {
    const fetch = mockFetch((url) => {
      if (url.includes("/compare/")) throw new Error("must not be asked");
      return pullResponse(stacked, '"v1"', { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(START_SEC + 600) });
    });

    const result = await resolverFor(fetch).resolve({ companyId: COMPANY, object: prObject() });

    expect(result).toEqual({ ok: true, snapshot: expect.objectContaining({ data: expect.objectContaining({ merged: true, mergeCommitReachable: false }) }) });
    expect(urls(fetch)).toEqual(["/repos/acme/app/pulls/42"]);
  });
});

describe("GitHub external object provider: rate limit", () => {
  it("sends nothing while the limit is exhausted and nothing is cached, and tells when to come back", async () => {
    setGitHubRateLimitForTests(START_SEC + 600, 0);
    const fetch = mockFetch(() => pullResponse());

    const result = await resolverFor(fetch).resolve({ companyId: COMPANY, object: prObject() });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      liveness: "unreachable",
      errorCode: "github_rate_limited",
      errorMessage: expect.any(String),
      retryAfterSeconds: 600,
    });
  });

  it("sends nothing while the limit is exhausted and returns the cached read, even an expired one", async () => {
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);
    const cached = await resolver.resolve({ companyId: COMPANY, object: prObject() });

    at(500);
    setGitHubRateLimitForTests(START_SEC + 1100, 0);
    const stale = await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(stale).toEqual(cached);
    expect(fetch).toHaveBeenCalledTimes(1);

    // An object that was never read is still refused.
    const unseen = await resolver.resolve({ companyId: COMPANY, object: prObject(43) });
    expect(unseen).toMatchObject({ ok: false, errorCode: "github_rate_limited", retryAfterSeconds: 600 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("goes back to GitHub, conditionally, once the window has passed", async () => {
    const fetch = mockFetch((_url, init) => (sentIfNoneMatch(init) ? notModified() : pullResponse()));
    const resolver = resolverFor(fetch);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    at(500);
    setGitHubRateLimitForTests(START_SEC + 1100, 0);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    expect(fetch).toHaveBeenCalledTimes(1);

    at(1101);
    const result = await resolver.resolve({ companyId: COMPANY, object: prObject() });
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentHeaders(fetch, 1)).toMatchObject({ "if-none-match": '"v1"' });
  });

  it("stops the reads that follow a rate-limit answer of GitHub itself", async () => {
    const fetch = mockFetch(() => new Response("", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(START_SEC + 900) },
    }));
    const resolver = resolverFor(fetch);

    const first = await resolver.resolve({ companyId: COMPANY, object: prObject(42) });
    const second = await resolver.resolve({ companyId: COMPANY, object: prObject(43) });

    expect(first).toMatchObject({ ok: false, errorCode: "github_rate_limited", retryAfterSeconds: 900 });
    expect(second).toMatchObject({ ok: false, errorCode: "github_rate_limited", retryAfterSeconds: 900 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh cache entry whether or not the limit is exhausted", async () => {
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);
    const cached = await resolver.resolve({ companyId: COMPANY, object: prObject() });

    setGitHubRateLimitForTests(START_SEC + 600, 0);

    expect(await resolver.resolve({ companyId: COMPANY, object: prObject() })).toEqual(cached);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub external object provider: invalidation", () => {
  it("drops one pull request, in any spelling of the repository, and keeps the rest", async () => {
    const fetch = mockFetch(() => pullResponse());
    const resolver = resolverFor(fetch);
    for (const object of [prObject(42), prObject(43), prObject(42, "acme/other")]) {
      await resolver.resolve({ companyId: COMPANY, object });
    }
    expect(fetch).toHaveBeenCalledTimes(3);

    invalidateGitHubPullRequestCache("Acme/App", 42);
    for (const object of [prObject(42), prObject(43), prObject(42, "acme/other")]) {
      await resolver.resolve({ companyId: COMPANY, object });
    }

    expect(urls(fetch).slice(3)).toEqual(["/repos/acme/app/pulls/42"]);
  });

  it("does not store a read that was on the wire when the pull request was invalidated", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const answers = [
      async () => { await gate; return pullResponse({}, '"before"'); },
      async () => pullResponse(MERGED, '"after"'),
    ];
    const fetch = mockFetch(() => answers.shift()!());
    const resolver = resolverFor(fetch);

    const early = resolver.resolve({ companyId: COMPANY, object: prObject() });
    invalidateGitHubPullRequestCache("acme/app", 42);
    release();
    await early;
    const later = await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(later).toEqual({ ok: true, snapshot: expect.objectContaining({ statusKey: "merged" }) });
  });

  describe("after the board merged the pull request", () => {
    const merge = { companyId: COMPANY, repository: "acme/app", number: 42, headSha: "abc123", method: "squash" } as const;

    function mergeClient(response: () => Response) {
      const send = vi.fn(async () => response());
      return { client: createGitHubBoardMergeClient({ fetch: send, tokenProvider: async () => "ghs_token" }), send };
    }

    it("reads the pull request again instead of serving the open one", async () => {
      const answers = [() => pullResponse({}, '"open"'), () => pullResponse(MERGED, '"merged"')];
      const fetch = mockFetch(() => answers.shift()!());
      const resolver = resolverFor(fetch);
      const before = await resolver.resolve({ companyId: COMPANY, object: prObject() });

      const { client, send } = mergeClient(() => new Response(JSON.stringify({ merged: true, sha: "m1" }), { status: 200 }));
      const outcome = await client.merge(merge);
      const after = await resolver.resolve({ companyId: COMPANY, object: prObject() });

      expect(outcome).toEqual({ status: "merged", sha: "m1" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(before).toEqual({ ok: true, snapshot: expect.objectContaining({ statusKey: "open" }) });
      expect(after).toEqual({ ok: true, snapshot: expect.objectContaining({ statusKey: "merged" }) });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["refuses", 405],
      ["finds the head moved", 409],
    ])("keeps the cached read when GitHub %s", async (_name, status) => {
      const fetch = mockFetch(() => pullResponse());
      const resolver = resolverFor(fetch);
      await resolver.resolve({ companyId: COMPANY, object: prObject() });

      const { client } = mergeClient(() => new Response(JSON.stringify({ message: "no" }), { status }));
      const outcome = await client.merge(merge);
      await resolver.resolve({ companyId: COMPANY, object: prObject() });

      expect(outcome.status).not.toBe("merged");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
