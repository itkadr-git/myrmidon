import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGitHubRateLimitForTests } from "../../services/github-rate-limit.js";
import {
  createReviewHeadFailedChecksResolver,
  createReviewPullRequestCiResolver,
  resetReviewCiCacheForTests,
  resolvePullRequestHeadCi,
  resolvePullRequestHeadFailedChecks,
} from "./github-ci.js";

// myrmidon(OPE-10045, OPE-10063): the CI read of a PR head never touches the
// network in tests. CI of the head is finished only by its final `CI result`
// check; a read the board cannot make answers "unknown" with a reason.

// myrmidon(OPE-12397): the CI reads are cached per process and the rate-limit state is process-wide.
// Every case here reads the same head from its own fake GitHub, so it runs with the cache off and
// with a fresh rate-limit state (the cache itself is covered in github-ci-cache.myrmidon.test.ts).
beforeEach(() => {
  vi.stubEnv("MYRMIDON_REVIEW_CI_PULL_CACHE_TTL_SEC", "0");
  vi.stubEnv("MYRMIDON_REVIEW_CI_COMPLETE_CACHE_TTL_SEC", "0");
  resetReviewCiCacheForTests();
  resetGitHubRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetGitHubRateLimitForTests();
});

const reference = { host: "github.com" as const, owner: "acme", repo: "app", number: 7 };

const PULL = "/repos/acme/app/pulls/7";
const CHECK_RUNS = "/repos/acme/app/commits/abc123/check-runs?check_name=CI%20result&filter=all&per_page=100";
// myrmidon(OPE-12048): the fallback read when no completed `CI result` run answers
// the filtered read above — every check of the head (the latest run of each name),
// third-party workflows included.
const ALL_CHECK_RUNS = "/repos/acme/app/commits/abc123/check-runs?filter=latest&per_page=100";
const openPull = { state: "open", head: { sha: "abc123" } };
/** A completed CI result check belonging to the current head. */
const ciResultOnHead = (conclusion: string) => ({ name: "CI result", status: "completed", conclusion, head_sha: "abc123" });

function fakeFetch(routes: Record<string, unknown>, calls: Array<{ path: string; headers: Record<string, string> }> = []) {
  return async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, headers });
    if (!(path in routes)) {
      if (path === "/repos/acme/app/contents/.github/workflows") {
        return new Response(JSON.stringify([{ name: "ci.yml" }]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }
    const route = routes[path];
    if (typeof route === "function") return (route as (headers: Record<string, string>) => Response)(headers);
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function status(code: number, headers: Record<string, string> = {}) {
  return () => new Response("{}", { status: code, headers });
}

describe("resolvePullRequestHeadCi", () => {
  it("recognizes a repository without workflows even if Checks is forbidden", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        "/repos/acme/app/contents/.github/workflows": status(404),
        [CHECK_RUNS]: status(403),
      }, calls),
    });
    expect(result).toEqual({ state: "not_configured", headSha: "abc123" });
    expect(calls.map((call) => call.path)).not.toContain(CHECK_RUNS);
  });

  it("does not mistake inaccessible workflows and Checks for absent CI", async () => {
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        "/repos/acme/app/contents/.github/workflows": status(403),
        [CHECK_RUNS]: status(403),
      }),
    });
    expect(result.state).toBe("unknown");
  });

  it("waits while a check of the head is still running, aggregate check or not", async () => {
    // OPE-9673 (#1972): every check queued, none finished.
    const queued = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [] },
        [ALL_CHECK_RUNS]: { total_count: 1, check_runs: [{ name: "build", status: "queued", conclusion: null }] },
      }),
    });
    expect(queued).toEqual({ state: "pending", headSha: "abc123" });
  });

  it("is not finished when `checks` failed but typecheck and tests are still queued", async () => {
    // OPE-8077 (#2027): the final check only appears when every lane it needs has ended, and the
    // other checks of the head are not what decides it, even if the server returns them.
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: {
          check_runs: [
            { name: "checks", status: "completed", conclusion: "failure" },
            { name: "typecheck + build", status: "queued", conclusion: null },
            { name: "tests (server 1/3)", status: "queued", conclusion: null },
          ],
        },
        [ALL_CHECK_RUNS]: {
          total_count: 3,
          check_runs: [
            { name: "checks", status: "completed", conclusion: "failure" },
            { name: "typecheck + build", status: "queued", conclusion: null },
            { name: "tests (server 1/3)", status: "queued", conclusion: null },
          ],
        },
      }),
    });
    expect(result).toEqual({ state: "pending", headSha: "abc123" });
  });

  it("does not take a red `freeze` check for a finished CI", async () => {
    // While the CI of a release tag runs, `freeze` is red on every PR.
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [{ name: "freeze", status: "completed", conclusion: "failure" }] },
        [ALL_CHECK_RUNS]: {
          total_count: 3,
          check_runs: [
            { name: "freeze", status: "completed", conclusion: "failure" },
            { name: "CI result", status: "queued", conclusion: null },
            { name: "typecheck + build", status: "completed", conclusion: "success" },
          ],
        },
      }),
    });
    expect(result.state).toBe("pending");
  });

  it("is pending while the final check is queued or in progress", async () => {
    for (const runStatus of ["queued", "in_progress", "waiting"]) {
      const result = await resolvePullRequestHeadCi({
        reference,
        token: "token",
        fetch: fakeFetch({
          [PULL]: openPull,
          [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: runStatus, conclusion: null, head_sha: "abc123" }] },
          [ALL_CHECK_RUNS]: {
            total_count: 2,
            check_runs: [
              { name: "CI result", status: runStatus, conclusion: null, head_sha: "abc123" },
              { name: "build", status: "completed", conclusion: "success" },
            ],
          },
        }),
      });
      expect(result.state).toBe("pending");
    }
  });

  it("is pending when the only final check left is one of a superseded workflow run", async () => {
    // PR #2027 on 30.10: `CI result` of earlier runs of the same head stay as completed/cancelled
    // while the run that counts is still queued.
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: {
          check_runs: [
            { name: "CI result", status: "completed", conclusion: "cancelled", head_sha: "abc123" },
            { name: "CI result", status: "completed", conclusion: "skipped", head_sha: "abc123" },
          ],
        },
        [ALL_CHECK_RUNS]: {
          total_count: 1,
          check_runs: [{ name: "CI result", status: "queued", conclusion: null }],
        },
      }),
    });
    expect(result.state).toBe("pending");
  });

  it("is complete once the final check is completed, green or red", async () => {
    for (const conclusion of ["success", "failure", "timed_out"]) {
      const result = await resolvePullRequestHeadCi({
        reference,
        token: "token",
        fetch: fakeFetch({
          [PULL]: openPull,
          [CHECK_RUNS]: { check_runs: [ciResultOnHead(conclusion)] },
        }),
      });
      // myrmidon(OPE-12176): the verdict travels with the state so review
      // admission can tell green from red without a second GitHub read.
      expect(result).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: conclusion });
    }
  });

  it("preserves completed-final-check state without a conclusion but excludes superseded runs", async () => {
    const missingConclusion = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: "completed", head_sha: "abc123" }] },
      }),
    });
    expect(missingConclusion).toEqual({ state: "complete", headSha: "abc123" });

    const superseded = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: {
          check_runs: [
            { name: "CI result", status: "completed", conclusion: "cancelled" },
            { name: "CI result", status: "completed", conclusion: "skipped" },
          ],
        },
      }),
    });
    expect(superseded).toEqual({ state: "pending", headSha: "abc123" });
  });

  it("reads the pull request and the final check only while the aggregate check answers", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch(
        { [PULL]: openPull, [CHECK_RUNS]: { check_runs: [ciResultOnHead("success")] } },
        calls,
      ),
    });
    expect(result.state).toBe("complete");
    expect(calls.map((call) => call.path)).toEqual([PULL, "/repos/acme/app/contents/.github/workflows", CHECK_RUNS]);
  });

  it("treats a merged or closed PR as having no CI to wait for", async () => {
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({ [PULL]: { state: "closed", merged: true, head: { sha: "abc123" } } }),
    });
    expect(result.state).toBe("no_pull_request");
  });

  it("answers unknown with a reason when GitHub cannot be read", async () => {
    expect(await resolvePullRequestHeadCi({ reference, token: null, fetch: fakeFetch({}) })).toEqual({
      state: "unknown",
      headSha: null,
      reason: "pull:http_404 (anonymous)",
    });
    expect(
      await resolvePullRequestHeadCi({ reference, token: null, fetch: fakeFetch({ [PULL]: openPull }) }),
    ).toEqual({ state: "unknown", headSha: "abc123", reason: "check_runs:http_404 (anonymous)" });
    expect(
      await resolvePullRequestHeadCi({
        reference,
        token: null,
        fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: "nope" } }),
      }),
    ).toMatchObject({ state: "unknown", reason: "check_runs:unreadable_payload" });
    expect(
      await resolvePullRequestHeadCi({
        reference,
        token: "token",
        fetch: async () => {
          throw new Error("socket hang up");
        },
      }),
    ).toMatchObject({ state: "unknown", reason: "pull:network_error" });
  });

  it("names a rate limit and never puts the token into the reason", async () => {
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "secret-token-value",
      fetch: fakeFetch({ [PULL]: status(403, { "x-ratelimit-remaining": "0" }) }),
    });
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("pull:http_403_rate_limited");
    expect(result.rateLimit).toEqual({ remaining: 0, limit: null, resetEpochSeconds: null });
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
  });

  it("does not retry anonymously when an authenticated request hits the rate limit", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "app-token",
      fetch: fakeFetch(
        { [PULL]: status(403, { "x-ratelimit-remaining": "0" }) },
        calls,
      ),
    });
    expect(result).toEqual({
      state: "unknown",
      headSha: null,
      reason: "pull:http_403_rate_limited",
      rateLimit: { remaining: 0, limit: null, resetEpochSeconds: null },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBeDefined();
  });

  it("measures the GitHub rate limit budget when a read is refused", async () => {
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "app-token",
      fetch: fakeFetch({
        [PULL]: status(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-limit": "15000",
          "x-ratelimit-reset": "1790000000",
        }),
      }),
    });
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("pull:http_403_rate_limited");
    expect(result.rateLimit).toEqual({ remaining: 0, limit: 15000, resetEpochSeconds: 1790000000 });
  });

  it("reads public data without the token when GitHub refuses the token", async () => {
    // An App token minted without the checks permission is refused by the check-runs endpoint.
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "app-token",
      fetch: fakeFetch(
        {
          [PULL]: openPull,
          [CHECK_RUNS]: (headers: Record<string, string>) =>
            headers.authorization
              ? new Response("{}", { status: 403 })
              : new Response(JSON.stringify({ check_runs: [ciResultOnHead("success")] }), {
                  status: 200,
                }),
        },
        calls,
      ),
    });
    expect(result).toEqual({ state: "complete", headSha: "abc123", finalCheckConclusion: "success" });
    expect(calls.map((call) => Boolean(call.headers.authorization))).toEqual([true, false, true, false]);
  });
});

describe("createReviewPullRequestCiResolver", () => {
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

  it("answers no_pull_request without a token or network call when the issue has no open PR", async () => {
    let tokenRequested = false;
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{ ...openProduct, status: "merged" }]),
      tokenProvider: async () => {
        tokenRequested = true;
        return "token";
      },
      fetch: fakeFetch({}),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "no_pull_request",
      pullRequestUrl: null,
      headSha: null,
    });
    expect(tokenRequested).toBe(false);
  });

  it("answers unknown with a reason when the PR cannot be read without a token", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => null,
      fetch: fakeFetch({}, calls),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "unknown",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: null,
      reason: "pull:http_404 (anonymous)",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("reads the public repository anonymously when no token is configured", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => null,
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [] },
        [ALL_CHECK_RUNS]: { total_count: 1, check_runs: [{ name: "build", status: "queued", conclusion: null }] },
      }, calls),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
    expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true);
  });

  it("falls back to an anonymous read and says so when the token provider fails", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => {
        throw new Error("Several GitHub Apps allow this repository");
      },
      fetch: fakeFetch({}),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toMatchObject({
      state: "unknown",
      reason: "pull:http_404 (anonymous); token provider failed",
    });
  });

  it("answers unknown with a reason when the PR reference cannot be read", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{ ...openProduct, url: "https://example.com/not-a-pull-request" }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({}),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "unknown",
      pullRequestUrl: "https://example.com/not-a-pull-request",
      headSha: null,
      reason: "pull_request_reference_unreadable",
    });
  });

  it("reads the head CI of the open PR", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{ ...openProduct, metadata: { repo: "acme/app", number: 7 } }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [] },
        [ALL_CHECK_RUNS]: {
          total_count: 1,
          check_runs: [{ name: "build", status: "queued", conclusion: null }],
        },
      }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
  });

  it("accepts a finished CI of a repository without the aggregate CI result check (OPE-12048)", async () => {
    // BastionPrime/wellboard PR #43: six lanes (build + lint-and-test), no `CI result`
    // aggregate check, all completed — the review verdict gate used to wait forever.
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{ ...openProduct, metadata: { repo: "acme/app", number: 7 } }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [] },
        [ALL_CHECK_RUNS]: {
          total_count: 6,
          check_runs: [
            { name: "build (mipsel_24kc)", status: "completed", conclusion: "success" },
            { name: "build (arm_cortex-a7_neon-vfpv4)", status: "completed", conclusion: "success" },
            { name: "build (aarch64_generic)", status: "completed", conclusion: "success" },
            { name: "build (aarch64_cortex-a53)", status: "completed", conclusion: "success" },
            { name: "lint-and-test", status: "completed", conclusion: "success" },
            { name: "build (x86_64)", status: "completed", conclusion: "success" },
          ],
        },
      }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "complete",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
  });

  it("waits when a third-party check of the head is still running", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [] },
        [ALL_CHECK_RUNS]: {
          total_count: 2,
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "lint-and-test", status: "in_progress", conclusion: null },
          ],
        },
      }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
  });

  // myrmidon(OPE-12024): a PR work product with empty url but metadata carrying
  // repository + number must still be readable — the CI resolver falls back to
  // the metadata fields instead of answering pull_request_reference_unreadable.
  it("falls back to metadata.repository and metadata.number when url is empty", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{
        ...openProduct,
        url: "",
        metadata: { repository: "acme/app", number: 7 },
      }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: "queued", head_sha: "abc123" }] } }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      // OPE-12024: пустая строка в url трактуется как отсутствие url —
      // effectiveUrl=null, т.к. metadata.url не задан.
      pullRequestUrl: null,
      headSha: "abc123",
    });
  });

  it("falls back to metadata.repo (shorthand) when url is empty", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{
        ...openProduct,
        url: "",
        metadata: { repo: "acme/app", number: 7 },
      }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: "queued", head_sha: "abc123" }] } }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: null,
      headSha: "abc123",
    });
  });

  it("still answers pull_request_reference_unreadable when url and metadata are both empty", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{ ...openProduct, url: "", metadata: {} }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({}),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "unknown",
      pullRequestUrl: null,
      headSha: null,
      reason: "pull_request_reference_unreadable",
    });
  });

  // myrmidon(OPE-12024): a stored '' url with metadata.url present must resolve
  // to the metadata address (the 107-record class the migration backfills).
  it("falls back to metadata.url when the stored url is an empty string", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{
        ...openProduct,
        url: "",
        metadata: { url: "https://github.com/acme/app/pull/7" },
      }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: "queued", head_sha: "abc123" }] } }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
  });

  it("prefers the stored url over metadata.url when both are present", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([{
        ...openProduct,
        url: "https://github.com/acme/app/pull/7",
        metadata: { url: "https://github.com/acme/other/pull/9" },
      }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: "queued", head_sha: "abc123" }] } }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
  });

  it("waits when the fallback read of all checks fails", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({
        [PULL]: openPull,
        [CHECK_RUNS]: { check_runs: [] },
      }),
    });
    // A 404 of the fallback read is retried once anonymously (readGitHub); a list
    // the board cannot read still must not block the verdict as "pending".
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toMatchObject({
      state: "unknown",
      headSha: "abc123",
      reason: "check_runs:http_404+anonymous:http_404",
    });
  });
});

// myrmidon(OPE-11970): the names of the checks that failed on a head, for the
// review-return guard. The latest run of every check name decides, so a check
// that failed and was re-run green is not listed; a list the board cannot read
// completely is "unknown".
const LATEST_CHECK_RUNS = "/repos/acme/app/commits/abc123/check-runs?filter=latest&per_page=100";

describe("resolvePullRequestHeadFailedChecks", () => {
  const head = { reference, token: "token", headSha: "abc123" };

  it("lists the checks that finished with a failing conclusion, once each", async () => {
    const result = await resolvePullRequestHeadFailedChecks({
      ...head,
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 8,
          check_runs: [
            { name: "typecheck + build", status: "completed", conclusion: "success" },
            { name: "tests (affected)", status: "completed", conclusion: "failure" },
            { name: "tests (affected)", status: "completed", conclusion: "failure" },
            { name: "checks", status: "completed", conclusion: "timed_out" },
            { name: "go tools (dockergate + fleetd)", status: "completed", conclusion: "cancelled" },
            { name: "plugin readiness timing", status: "completed", conclusion: "skipped" },
            { name: "plan", status: "in_progress", conclusion: null },
            { name: "CI result", status: "completed", conclusion: "failure" },
          ],
        },
      }),
    });

    expect(result).toEqual({ state: "ok", failed: ["tests (affected)", "checks", "CI result"] });
  });

  it("lists nothing when no check failed", async () => {
    const result = await resolvePullRequestHeadFailedChecks({
      ...head,
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 1,
          check_runs: [{ name: "CI result", status: "completed", conclusion: "success" }],
        },
      }),
    });

    expect(result).toEqual({ state: "ok", failed: [] });
  });

  it("is unknown when the list does not fit one page: a partial list could hide a code failure", async () => {
    const result = await resolvePullRequestHeadFailedChecks({
      ...head,
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 140,
          check_runs: [{ name: "CI result", status: "completed", conclusion: "failure" }],
        },
      }),
    });

    expect(result).toEqual({ state: "unknown", reason: "check_runs:more_than_one_page" });
  });

  it("is unknown with a reason when GitHub refuses the read", async () => {
    const result = await resolvePullRequestHeadFailedChecks({
      ...head,
      fetch: fakeFetch({ [LATEST_CHECK_RUNS]: status(500) }),
    });

    expect(result).toEqual({ state: "unknown", reason: "check_runs:http_500" });
  });

  it("is unknown when the payload has no check run list", async () => {
    const result = await resolvePullRequestHeadFailedChecks({
      ...head,
      fetch: fakeFetch({ [LATEST_CHECK_RUNS]: { total_count: 0 } }),
    });

    expect(result).toEqual({ state: "unknown", reason: "check_runs:unreadable_payload" });
  });
});

describe("createReviewHeadFailedChecksResolver", () => {
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

  it("is unknown, without a token request or a network call, when the issue has no open PR", async () => {
    let tokenRequested = false;
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const resolver = createReviewHeadFailedChecksResolver({
      db: fakeDb([{ ...openProduct, status: "merged" }]),
      tokenProvider: async () => {
        tokenRequested = true;
        return "token";
      },
      fetch: fakeFetch({}, calls),
    });

    expect(await resolver({ companyId: "company-1", issueId: "issue-1", headSha: "abc123" })).toEqual({
      state: "unknown",
      reason: "no_pull_request",
    });
    expect(tokenRequested).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("is unknown when the PR reference cannot be read", async () => {
    const resolver = createReviewHeadFailedChecksResolver({
      db: fakeDb([{ ...openProduct, url: "https://example.com/not-a-pull-request" }]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({}),
    });

    expect(await resolver({ companyId: "company-1", issueId: "issue-1", headSha: "abc123" })).toEqual({
      state: "unknown",
      reason: "pull_request_reference_unreadable",
    });
  });

  it("reads the failed checks of the head the decision was made on", async () => {
    const resolver = createReviewHeadFailedChecksResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 2,
          check_runs: [
            { name: "CI result", status: "completed", conclusion: "failure" },
            { name: "main-green", status: "completed", conclusion: "success" },
          ],
        },
      }),
    });

    expect(await resolver({ companyId: "company-1", issueId: "issue-1", headSha: "abc123" })).toEqual({
      state: "ok",
      headSha: "abc123",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      failed: ["CI result"],
    });
  });

  it("reads anonymously and still answers when the token provider fails", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const resolver = createReviewHeadFailedChecksResolver({
      db: fakeDb([openProduct]),
      tokenProvider: async () => {
        throw new Error("Several GitHub Apps allow this repository");
      },
      fetch: fakeFetch({ [LATEST_CHECK_RUNS]: { total_count: 0, check_runs: [] } }, calls),
    });

    expect(await resolver({ companyId: "company-1", issueId: "issue-1", headSha: "abc123" })).toMatchObject({
      state: "ok",
      failed: [],
    });
    expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true);
  });
});
