import { describe, expect, it } from "vitest";
import {
  extractPullRequestIssueIdentifier,
  pullRequestWorkProductData,
} from "./linking.js";

describe("extractPullRequestIssueIdentifier", () => {
  it("reads the task key from a bot branch", () => {
    expect(extractPullRequestIssueIdentifier({ headRef: "bot/OPE-12207" })).toBe("OPE-12207");
    expect(extractPullRequestIssueIdentifier({ headRef: "BOT/ope-12483" })).toBe("OPE-12483");
  });

  it("ignores a branch that is not the bot pattern for the issue key", () => {
    expect(extractPullRequestIssueIdentifier({ headRef: "bot/not-a-key" })).toBeNull();
    expect(extractPullRequestIssueIdentifier({ headRef: "bot/OPE-12207-extra" })).toBeNull();
    expect(extractPullRequestIssueIdentifier({ headRef: "feature/OPE-1-fix" })).toBeNull();
    expect(extractPullRequestIssueIdentifier({ headRef: "" })).toBeNull();
    expect(extractPullRequestIssueIdentifier({ headRef: undefined })).toBeNull();
  });

  it("falls back to the first task key in the title", () => {
    expect(
      extractPullRequestIssueIdentifier({ headRef: "fix/acceptance-gate", title: "OPE-12483: fix the gate" }),
    ).toBe("OPE-12483");
    expect(
      extractPullRequestIssueIdentifier({ headRef: "", title: "port F (#2631) — see OPE-12031" }),
    ).toBe("OPE-12031");
  });

  it("returns null without a key anywhere", () => {
    expect(extractPullRequestIssueIdentifier({ headRef: "fix/thing", title: "no key here" })).toBeNull();
    expect(extractPullRequestIssueIdentifier({})).toBeNull();
  });
});

describe("pullRequestWorkProductData", () => {
  it("builds an open linked work product", () => {
    const data = pullRequestWorkProductData({
      repository: "itkadr-git/myrmidon",
      number: 2613,
      url: "https://github.com/itkadr-git/myrmidon/pull/2613",
      title: "OPE-12207: deliver",
      headRef: "bot/OPE-12207",
      headSha: "abc123",
      state: "open",
      merged: false,
    });
    expect(data.type).toBe("pull_request");
    expect(data.provider).toBe("github");
    expect(data.externalId).toBe("itkadr-git/myrmidon#pull/2613");
    expect(data.status).toBe("open");
    expect(data.isPrimary).toBe(true);
    expect(data.metadata).toMatchObject({
      repository: "itkadr-git/myrmidon",
      repo: "itkadr-git/myrmidon",
      number: 2613,
      branch: "bot/OPE-12207",
      headRef: "bot/OPE-12207",
      state: "open",
    });
  });

  it("maps closed and merged states", () => {
    expect(
      pullRequestWorkProductData({
        repository: "r/n", number: 1, url: null, title: null, headRef: null, headSha: null,
        state: "closed", merged: false,
      }).status,
    ).toBe("closed");
    expect(
      pullRequestWorkProductData({
        repository: "r/n", number: 2, url: null, title: null, headRef: null, headSha: null,
        state: "closed", merged: true,
      }).status,
    ).toBe("merged");
  });

  it("synthesizes the url and title when the payload lacks them", () => {
    const data = pullRequestWorkProductData({
      repository: "itkadr-git/myrmidon", number: 7, url: null, title: null, headRef: null, headSha: null,
      state: "open", merged: false,
    });
    expect(data.url).toBe("https://github.com/itkadr-git/myrmidon/pull/7");
    expect(data.title).toBe("GitHub PR #7");
  });
});
