import { describe, expect, it } from "vitest";
import { resolveReleaseRefs } from "./release-membership.js";

describe("resolveReleaseRefs request contract", () => {
  it("uses exact GitHub and enterprise URLs and isolates authorization between calls", async () => {
    const calls: Array<{ input: string; headers: Record<string, string> }> = [];
    const bodies = [
      [{ ref: "refs/tags/myr-v1.7.1" }],
      [{ ref: "refs/heads/rel/1.7-fixes" }],
      [{ ref: "refs/tags/myr-v1.7.2" }],
      [{ ref: "refs/heads/rel/1.7-next" }],
      [{ ref: "refs/tags/myr-v1.7.3" }],
      [{ ref: "refs/heads/rel/1.7-hotfix" }],
    ];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      calls.push({ input, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(JSON.stringify(bodies[calls.length - 1]), { status: 200 });
    };
    const common = { repository: "space owner/repo #1", releasePrefix: "1.7", fetchImpl };
    expect(await resolveReleaseRefs({ ...common, token: "  synthetic token  " })).toEqual([
      { ref: "myr-v1.7.1", kind: "tag" }, { ref: "rel/1.7-fixes", kind: "branch" },
    ]);
    expect(await resolveReleaseRefs({ ...common, host: "github.example.com" })).toEqual([
      { ref: "myr-v1.7.2", kind: "tag" }, { ref: "rel/1.7-next", kind: "branch" },
    ]);
    expect(await resolveReleaseRefs({ ...common, host: "github.example.com", token: "" })).toEqual([
      { ref: "myr-v1.7.3", kind: "tag" }, { ref: "rel/1.7-hotfix", kind: "branch" },
    ]);
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    expect(calls).toEqual([
      { input: "https://api.github.com/repos/space%20owner/repo%20%231/git/matching-refs/tags/myr-v1.7", headers: { ...headers, authorization: "Bearer synthetic token" } },
      { input: "https://api.github.com/repos/space%20owner/repo%20%231/git/matching-refs/branches/rel%2F1.7", headers: { ...headers, authorization: "Bearer synthetic token" } },
      { input: "https://github.example.com/api/v3/repos/space%20owner/repo%20%231/git/matching-refs/tags/myr-v1.7", headers },
      { input: "https://github.example.com/api/v3/repos/space%20owner/repo%20%231/git/matching-refs/branches/rel%2F1.7", headers },
      { input: "https://github.example.com/api/v3/repos/space%20owner/repo%20%231/git/matching-refs/tags/myr-v1.7", headers },
      { input: "https://github.example.com/api/v3/repos/space%20owner/repo%20%231/git/matching-refs/branches/rel%2F1.7", headers },
    ]);
  });

  it("does not request refs for a repository without a slash", async () => {
    const calls: string[] = [];
    const result = await resolveReleaseRefs({
      repository: "invalid", releasePrefix: "1.7",
      fetchImpl: async (input) => { calls.push(input); return new Response("[]"); },
    });
    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });
});
