import { describe, expect, it, vi } from "vitest";
import { repositoryHasHostedCi, NO_HOSTED_CI_SUMMARY } from "../github-hosted-ci.js";
import { createPullRequestCiResolver, clearCiCacheForTests } from "../github-pull-request-ci.js";

const reference = { host: "github.com" as const, owner: "acme", repo: "app", number: 7 };
const workflowPath = "/contents/.github/workflows";

describe("repositoryHasHostedCi", () => {
  it("distinguishes absent workflows from inaccessible workflows", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response("{}", {
      status: init?.headers && "Authorization" in (init.headers as Record<string, string>) ? 403 : 404,
    }));
    expect(await repositoryHasHostedCi({ ...reference, token: "token", fetch })).toBeNull();
    expect(await repositoryHasHostedCi({ ...reference, token: null, fetch })).toBe(false);
  });
  it("recognizes YAML workflows and ignores unrelated directory files", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ name: "README.md" }, { name: "ci.yaml" }])));
    expect(await repositoryHasHostedCi({ ...reference, token: null, fetch })).toBe(true);
  });
});

describe("PR ci-status without hosted CI", () => {
  it("returns not_configured, not denied, when Checks is 403 and workflows are absent", async () => {
    clearCiCacheForTests();
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes(workflowPath)) return new Response("{}", { status: 404 });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 });
      return new Response(JSON.stringify({ head: { sha: "head-no-ci", ref: "main" }, state: "open" }));
    });
    const resolver = createPullRequestCiResolver({ select: vi.fn() } as never, {
      fetch: fetch as never,
      tokenProvider: async () => "token",
      prResolver: async () => ({ headSha: "head-no-ci", headRef: "main" }),
    });
    const result = await resolver.resolveForPullRequest("company-no-ci", reference);
    expect(calls.some((url) => url.includes("/check-runs"))).toBe(true);
    expect(result).toMatchObject({ status: "not_configured", conclusion: "not_configured", summary: NO_HOSTED_CI_SUMMARY, headSha: "head-no-ci" });
  });
});
