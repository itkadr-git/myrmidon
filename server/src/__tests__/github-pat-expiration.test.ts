import { describe, expect, it, vi } from "vitest";
import {
  isGitHubPatExpiring,
  parseGitHubPatExpiration,
  readGitHubPatExpiration,
} from "../services/github-pat-expiration.js";

describe("GitHub fine-grained PAT expiry", () => {
  it("reads only a valid GitHub expiration header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "github-authentication-token-expiration": "2026-11-10T00:00:00Z" },
    }));
    expect(await readGitHubPatExpiration("github_pat_test", fetchImpl)).toBe("2026-11-10T00:00:00.000Z");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer github_pat_test" }),
    }));
    expect(await readGitHubPatExpiration("ghp_classic", fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parseGitHubPatExpiration("not-a-date")).toBeNull();
  });

  it("warns at seven days, including expired credentials", () => {
    const now = Date.parse("2026-11-04T00:00:00Z");
    expect(isGitHubPatExpiring("2026-11-11T00:00:00Z", now)).toBe(true);
    expect(isGitHubPatExpiring("2026-11-11T00:00:01Z", now)).toBe(false);
    expect(isGitHubPatExpiring("2026-11-03T00:00:00Z", now)).toBe(true);
    expect(isGitHubPatExpiring(null, now)).toBe(false);
  });
});
