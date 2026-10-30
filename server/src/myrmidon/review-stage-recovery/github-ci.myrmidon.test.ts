import { describe, expect, it } from "vitest";
import { createReviewPullRequestCiResolver, resolvePullRequestHeadCi } from "./github-ci.js";

// myrmidon(OPE-10045): the CI read of a PR head never touches the network in
// tests and never invents a wait it cannot see.

const reference = { host: "github.com" as const, owner: "acme", repo: "app", number: 7 };

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const path = url.replace("https://api.github.com", "");
    if (!(path in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("resolvePullRequestHeadCi", () => {
  it("reads pending checks on the current head", async () => {
    const calls: string[] = [];
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch(
        {
          "/repos/acme/app/pulls/7": { state: "open", head: { sha: "abc123" } },
          "/repos/acme/app/commits/abc123/check-runs?per_page=100": {
            check_runs: [{ status: "completed", conclusion: "success" }, { status: "in_progress" }],
          },
          "/repos/acme/app/commits/abc123/status": { state: "pending", statuses: [] },
        },
        calls,
      ),
    });
    expect(result).toEqual({ state: "pending", headSha: "abc123" });
    expect(calls).toHaveLength(3);
  });

  it("reads finished checks as complete", async () => {
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({
        "/repos/acme/app/pulls/7": { state: "open", head: { sha: "abc123" } },
        "/repos/acme/app/commits/abc123/check-runs?per_page=100": {
          check_runs: [{ status: "completed", conclusion: "failure" }],
        },
        "/repos/acme/app/commits/abc123/status": { state: "failure", statuses: [{ state: "failure" }] },
      }),
    });
    expect(result).toEqual({ state: "complete", headSha: "abc123" });
  });

  it("treats a merged or closed PR as having no CI to wait for", async () => {
    const result = await resolvePullRequestHeadCi({
      reference,
      token: "token",
      fetch: fakeFetch({ "/repos/acme/app/pulls/7": { state: "closed", merged: true, head: { sha: "abc123" } } }),
    });
    expect(result.state).toBe("no_pull_request");
  });

  it("answers unknown when GitHub cannot be read", async () => {
    expect(
      (await resolvePullRequestHeadCi({ reference, token: "token", fetch: fakeFetch({}) })).state,
    ).toBe("unknown");
    expect(
      (
        await resolvePullRequestHeadCi({
          reference,
          token: "token",
          fetch: fakeFetch({ "/repos/acme/app/pulls/7": { state: "open", head: { sha: "abc123" } } }),
        })
      ).state,
    ).toBe("unknown");
  });
});

describe("createReviewPullRequestCiResolver", () => {
  function fakeDb(rows: unknown[]) {
    return {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as never;
  }

  it("answers no_pull_request without a token or network call when the issue has no open PR", async () => {
    let tokenRequested = false;
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([
        { id: "wp-1", type: "pull_request", status: "merged", url: "https://github.com/acme/app/pull/7", metadata: null, isPrimary: true, updatedAt: new Date() },
      ]),
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

  it("answers unknown without a token", async () => {
    const calls: string[] = [];
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([
        { id: "wp-1", type: "pull_request", status: "open", url: "https://github.com/acme/app/pull/7", metadata: null, isPrimary: true, updatedAt: new Date() },
      ]),
      tokenProvider: async () => null,
      fetch: fakeFetch({}, calls),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toMatchObject({
      state: "unknown",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
    });
    expect(calls).toHaveLength(0);
  });

  it("reads the head CI of the open PR", async () => {
    const resolver = createReviewPullRequestCiResolver({
      db: fakeDb([
        { id: "wp-1", type: "pull_request", status: "open", url: "https://github.com/acme/app/pull/7", metadata: { repo: "acme/app", number: 7 }, isPrimary: true, updatedAt: new Date() },
      ]),
      tokenProvider: async () => "token",
      fetch: fakeFetch({
        "/repos/acme/app/pulls/7": { state: "open", head: { sha: "abc123" } },
        "/repos/acme/app/commits/abc123/check-runs?per_page=100": { check_runs: [{ status: "queued" }] },
        "/repos/acme/app/commits/abc123/status": { state: "pending", statuses: [] },
      }),
    });
    expect(await resolver({ companyId: "company-1", issueId: "issue-1" })).toEqual({
      state: "pending",
      pullRequestUrl: "https://github.com/acme/app/pull/7",
      headSha: "abc123",
    });
  });
});
