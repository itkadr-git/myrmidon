import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetGitHubRateLimitForTests } from "../../services/github-rate-limit.js";
import { readPullRequestHeadCheckRunsNow } from "../review-stage-recovery/github-ci.js";
import { createCiReturnFactsResolver } from "./ci-failure-return-facts.js";

// myrmidon(EMPTY-RUNS-3): the GitHub read behind the CI return decision. It
// never touches the network in tests, is not cached (the decision is made once,
// on the delivery of the final check) and answers "unknown" with a short reason
// for anything it cannot read.

beforeEach(() => {
  resetGitHubRateLimitForTests();
});

afterEach(() => {
  resetGitHubRateLimitForTests();
});

const HEAD = "a".repeat(40);
const reference = { host: "github.com" as const, owner: "acme", repo: "app", number: 7 };
const LATEST_CHECK_RUNS = `/repos/acme/app/commits/${HEAD}/check-runs?filter=latest&per_page=100`;

function fakeFetch(routes: Record<string, unknown>, calls: Array<{ path: string; headers: Record<string, string> }> = []) {
  return async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, headers });
    if (!(path in routes)) return new Response("not found", { status: 404 });
    const route = routes[path];
    if (typeof route === "function") return (route as () => Response)();
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, head_sha: HEAD });

describe("readPullRequestHeadCheckRunsNow", () => {
  const head = { reference, token: "token", headSha: HEAD };

  it("reports a head whose aggregate check has not been created yet as not final", async () => {
    const result = await readPullRequestHeadCheckRunsNow({
      ...head,
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 3,
          check_runs: [
            run("tests (server 3/6)", "completed", "failure"),
            run("typecheck + build", "in_progress", null),
            run("main-green", "completed", "failure"),
          ],
        },
      }),
    });

    expect(result).toEqual({
      state: "ok",
      failed: ["tests (server 3/6)", "main-green"],
      finished: false,
      hasFinalCheck: false,
      finalCheckConclusion: null,
    });
  });

  it("reports the verdict of the finished aggregate check and the checks that failed", async () => {
    const result = await readPullRequestHeadCheckRunsNow({
      ...head,
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 5,
          check_runs: [
            run("typecheck + build", "completed", "success"),
            run("tests (serialized 1/2)", "completed", "failure"),
            run("checks", "completed", "timed_out"),
            run("plugin readiness timing", "completed", "skipped"),
            run("CI result", "completed", "failure"),
          ],
        },
      }),
    });

    expect(result).toEqual({
      state: "ok",
      failed: ["tests (serialized 1/2)", "checks", "CI result"],
      finished: true,
      hasFinalCheck: true,
      finalCheckConclusion: "failure",
    });
  });

  it("does not take a cancelled or still running aggregate check for a verdict", async () => {
    const cancelled = await readPullRequestHeadCheckRunsNow({
      ...head,
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 2,
          check_runs: [run("tests (affected)", "completed", "failure"), run("CI result", "completed", "cancelled")],
        },
      }),
    });
    expect(cancelled).toMatchObject({ state: "ok", hasFinalCheck: true, finalCheckConclusion: null, finished: true });

    const running = await readPullRequestHeadCheckRunsNow({
      ...head,
      fetch: fakeFetch({
        [LATEST_CHECK_RUNS]: {
          total_count: 2,
          check_runs: [run("tests (affected)", "completed", "failure"), run("CI result", "in_progress", null)],
        },
      }),
    });
    expect(running).toMatchObject({ state: "ok", hasFinalCheck: true, finalCheckConclusion: null, finished: false });
  });

  it("asks GitHub every time: the decision is made on one delivery and a remembered list would hide the final check", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const fetch = fakeFetch(
      { [LATEST_CHECK_RUNS]: { total_count: 1, check_runs: [run("CI result", "completed", "success")] } },
      calls,
    );

    await readPullRequestHeadCheckRunsNow({ ...head, fetch });
    await readPullRequestHeadCheckRunsNow({ ...head, fetch });

    expect(calls.map((call) => call.path)).toEqual([LATEST_CHECK_RUNS, LATEST_CHECK_RUNS]);
  });

  it("is unknown when the list does not fit one page, the payload is unreadable or GitHub refuses", async () => {
    expect(
      await readPullRequestHeadCheckRunsNow({
        ...head,
        fetch: fakeFetch({
          [LATEST_CHECK_RUNS]: { total_count: 140, check_runs: [run("CI result", "completed", "failure")] },
        }),
      }),
    ).toEqual({ state: "unknown", reason: "check_runs:more_than_one_page" });
    expect(
      await readPullRequestHeadCheckRunsNow({ ...head, fetch: fakeFetch({ [LATEST_CHECK_RUNS]: { total_count: 0 } }) }),
    ).toEqual({ state: "unknown", reason: "check_runs:unreadable_payload" });
    expect(
      await readPullRequestHeadCheckRunsNow({
        ...head,
        fetch: fakeFetch({ [LATEST_CHECK_RUNS]: () => new Response("{}", { status: 500 }) }),
      }),
    ).toEqual({ state: "unknown", reason: "check_runs:http_500" });
  });
});

describe("createCiReturnFactsResolver", () => {
  const input = { companyId: "company-1", repository: "acme/app", pullRequestNumber: 7, headSha: HEAD };

  it("reads the check runs of the head of the named pull request with the company token", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const tokenRequests: Array<{ companyId: string; repository: string }> = [];
    const resolver = createCiReturnFactsResolver({
      db: {} as never,
      tokenProvider: async (companyId, repository) => {
        tokenRequests.push({ companyId, repository });
        return "token";
      },
      fetch: fakeFetch(
        {
          [LATEST_CHECK_RUNS]: {
            total_count: 2,
            check_runs: [run("tests (affected)", "completed", "failure"), run("CI result", "completed", "failure")],
          },
        },
        calls,
      ),
    });

    expect(await resolver(input)).toEqual({
      state: "ok",
      failed: ["tests (affected)", "CI result"],
      finished: true,
      hasFinalCheck: true,
      finalCheckConclusion: "failure",
    });
    expect(tokenRequests).toEqual([{ companyId: "company-1", repository: "acme/app" }]);
    expect(calls.map((call) => call.path)).toEqual([LATEST_CHECK_RUNS]);
    expect(calls[0]?.headers.authorization).toBe("Bearer token");
  });

  it("reads anonymously when the token provider fails", async () => {
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const resolver = createCiReturnFactsResolver({
      db: {} as never,
      tokenProvider: async () => {
        throw new Error("no token");
      },
      fetch: fakeFetch(
        { [LATEST_CHECK_RUNS]: { total_count: 1, check_runs: [run("CI result", "completed", "success")] } },
        calls,
      ),
    });

    expect(await resolver(input)).toMatchObject({ state: "ok", failed: [], finalCheckConclusion: "success" });
    expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true);
  });

  it("is unknown, without a token request or a network call, when the repository is not a GitHub owner/repo", async () => {
    let tokenRequested = false;
    const calls: Array<{ path: string; headers: Record<string, string> }> = [];
    const resolver = createCiReturnFactsResolver({
      db: {} as never,
      tokenProvider: async () => {
        tokenRequested = true;
        return "token";
      },
      fetch: fakeFetch({}, calls),
    });

    expect(await resolver({ ...input, repository: "not a repository" })).toEqual({
      state: "unknown",
      reason: "pull_request_reference_unreadable",
    });
    expect(tokenRequested).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
