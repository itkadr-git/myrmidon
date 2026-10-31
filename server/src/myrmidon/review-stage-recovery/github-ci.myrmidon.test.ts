import { describe, expect, it } from "vitest";
import { createReviewPullRequestCiResolver, resolvePullRequestHeadCi } from "./github-ci.js";

// myrmidon(OPE-10045, OPE-10063): the CI read of a PR head never touches the
// network in tests. CI of the head is finished only by its final `CI result`
// check; a read the board cannot make answers "unknown" with a reason.

const reference = { host: "github.com" as const, owner: "acme", repo: "app", number: 7 };

const PULL = "/repos/acme/app/pulls/7";
const CHECK_RUNS = "/repos/acme/app/commits/abc123/check-runs?check_name=CI%20result&filter=all&per_page=100";
const openPull = { state: "open", head: { sha: "abc123" } };

function fakeFetch(routes: Record<string, unknown>, calls: Array<{ path: string; headers: Record<string, string> }> = []) {
  return async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, headers });
    if (!(path in routes)) return new Response("not found", { status: 404 });
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
  it("waits while the final CI result check does not exist yet, whatever else is running", async () => {
    // OPE-9673 (#1972): every check queued, none finished.
    const queued = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [] } }),
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
          [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: runStatus, conclusion: null }] },
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
            { name: "CI result", status: "completed", conclusion: "cancelled" },
            { name: "CI result", status: "completed", conclusion: "skipped" },
          ],
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
          [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: "completed", conclusion }] },
        }),
      });
      expect(result).toEqual({ state: "complete", headSha: "abc123" });
    }
  });

  it("reads the pull request and the final check only", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [] } }, calls),
    });
    expect(calls.map((call) => call.path)).toEqual([PULL, CHECK_RUNS]);
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
    expect(result.reason).toBe("pull:http_403_rate_limited+anonymous:http_403_rate_limited");
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
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
              : new Response(JSON.stringify({ check_runs: [{ name: "CI result", status: "completed", conclusion: "success" }] }), {
                  status: 200,
                }),
        },
        calls,
      ),
    });
    expect(result).toEqual({ state: "complete", headSha: "abc123" });
    expect(calls.map((call) => Boolean(call.headers.authorization))).toEqual([true, true, false]);
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
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [] } }, calls),
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
      fetch: fakeFetch({ [PULL]: openPull, [CHECK_RUNS]: { check_runs: [{ name: "CI result", status: "queued" }] } }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
  });
});
