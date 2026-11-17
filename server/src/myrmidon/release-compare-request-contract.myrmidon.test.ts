import { describe, expect, it, vi } from "vitest";
import { checkCommitInRef } from "./release-membership.js";

const sha = "abc123def456abc123def456abc123def456abc1";
const ref = { ref: "rel/1.7-fixes", kind: "branch" } as const;
const repository = "owner name/repo#one";

function response(status: string, aheadBy: number, behindBy: number): Response {
  return new Response(JSON.stringify({ status, ahead_by: aheadBy, behind_by: behindBy }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("checkCommitInRef compare request contract", () => {
  it("encodes the compare URL and sends trimmed credentials without leaking them to a later anonymous request", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response("identical", 0, 0))
      .mockResolvedValueOnce(response("diverged", 2, 3));

    expect(await checkCommitInRef({ repository, ref, sha, token: "  synthetic-token  ", fetchImpl })).toBe(true);
    expect(await checkCommitInRef({ repository, ref, sha, host: "git.example.test", fetchImpl })).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1,
      `https://api.github.com/repos/owner%20name/repo%23one/compare/rel%2F1.7-fixes...${sha}`,
      { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: "Bearer synthetic-token" } },
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(2,
      `https://git.example.test/api/v3/repos/owner%20name/repo%23one/compare/rel%2F1.7-fixes...${sha}`,
      { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } },
    );
  });

  it.each([
    ["identical", 0, 0, true],
    ["behind", 0, 3, true],
    ["diverged", 2, 3, false],
  ])("maps a valid %s response to %s/%s membership", async (status, ahead, behind, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(status, ahead, behind));
    expect(await checkCommitInRef({ repository, ref, sha, fetchImpl })).toBe(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/owner%20name/repo%23one/compare/rel%2F1.7-fixes...${sha}`,
      { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } },
    );
  });

  it.each([
    ["empty SHA", repository, ""],
    ["repository without slash", "invalid", sha],
  ])("returns null without fetching for %s", async (_case, invalidRepository, invalidSha) => {
    const fetchImpl = vi.fn();
    expect(await checkCommitInRef({ repository: invalidRepository, ref, sha: invalidSha, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
