import { describe, expect, it } from "vitest";
import { runMatchesCurrentRelease } from "../myrmidon/run-priority/scoring.js";

describe("release-focused wake decision", () => {
  const currentRelease = "1.6.9";
  const shouldDefer = (targetLabels: string[], openIssueLabels: string[], manualUserWake = false) => {
    const targetMatchesRelease = runMatchesCurrentRelease(currentRelease, targetLabels);
    const hasOpenCurrentReleaseIssue = openIssueLabels.some((label) =>
      runMatchesCurrentRelease(currentRelease, [label]),
    );
    return !manualUserWake && Boolean(currentRelease) && hasOpenCurrentReleaseIssue && !targetMatchesRelease;
  };

  it("defers a non-release wake while release work is open", () => {
    expect(shouldDefer(["1.8"], ["1.6.9"])).toBe(true);
  });

  it("allows the release wake and permits other work once release work is closed", () => {
    expect(shouldDefer(["1.6.9"], ["1.6.9"])).toBe(false);
    expect(shouldDefer(["1.8"], [])).toBe(false);
  });

  it("preserves manual user overrides", () => {
    expect(shouldDefer(["1.8"], ["1.6.9"], true)).toBe(false);
  });
});
