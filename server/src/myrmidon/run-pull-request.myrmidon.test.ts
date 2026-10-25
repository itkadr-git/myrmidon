import { describe, expect, it } from "vitest";
import { selectRunPullRequest } from "./run-pull-request.js";

const pr = (over: Record<string, unknown> = {}) => ({
  type: "pull_request" as const,
  provider: "github",
  url: null as string | null,
  status: "active",
  metadata: null as Record<string, unknown> | null,
  ...over,
});

describe("selectRunPullRequest (the task's PR for the bot workspace)", () => {
  it("takes repo and head branch from the work product metadata", () => {
    expect(
      selectRunPullRequest([pr({ metadata: { repo: "itkadr-git/myrmidon-deploy", number: 82, headRef: "fix/ope-7967" } })]),
    ).toEqual({ repo: "itkadr-git/myrmidon-deploy", number: 82, headRef: "fix/ope-7967" });
  });

  it("falls back to the repository named by the PR url, without a branch", () => {
    expect(selectRunPullRequest([pr({ url: "https://github.com/itkadr-git/myrmidon-deploy/pull/82" })])).toEqual({
      repo: "itkadr-git/myrmidon-deploy",
      number: 82,
    });
  });

  it("skips merged and closed pull requests and other work product types", () => {
    expect(
      selectRunPullRequest([
        pr({ status: "merged", metadata: { repo: "a/merged" } }),
        pr({ metadata: { repo: "a/closed", state: "closed" } }),
        { ...pr({ metadata: { repo: "a/preview" } }), type: "preview_url" as never },
        pr({ metadata: { repo: "a/open", headRef: "refs/heads/feat" } }),
      ]),
    ).toEqual({ repo: "a/open", headRef: "feat" });
    expect(selectRunPullRequest([pr({ status: "merged", metadata: { repo: "a/merged" } })])).toBeNull();
    expect(selectRunPullRequest([])).toBeNull();
  });

  it("keeps the order it is given (primary first) and drops unusable repos and refs", () => {
    expect(
      selectRunPullRequest([
        pr({ metadata: { repo: "not a repo" } }),
        pr({ metadata: { repo: "a/first", headRef: "--upload-pack=x" } }),
        pr({ metadata: { repo: "a/second", headRef: "ok" } }),
      ]),
    ).toEqual({ repo: "a/first" });
    expect(selectRunPullRequest([pr({ metadata: { repo: "a/b", headRef: "x..y" } })])).toEqual({ repo: "a/b" });
  });
});
