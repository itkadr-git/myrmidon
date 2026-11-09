import { describe, expect, it } from "vitest";
import { buildRecoveryDedupeKey } from "@myrmidon/shared";
import { classifyWorkspaceRecoveryCause } from "./classify-workspace.js";
import { workspaceRecoveryFixtures } from "./__fixtures__/workspace-signals.js";

describe("classifyWorkspaceRecoveryCause", () => {
  it.each(workspaceRecoveryFixtures)("classifies observed signal from $source", fixture => {
    expect(classifyWorkspaceRecoveryCause({ message: fixture.message, exitCode: fixture.exitCode })).toMatchObject({
      kind: fixture.kind,
      cause: fixture.cause,
      scope: "workspace:unspecified",
    });
  });

  it.each([
    { message: "the log mentions myr-ws quota but this was a test fixture", exitCode: 1 },
    { message: "devbuild failed somewhere in documentation", exitCode: 1 },
    { message: "BOT_DISK_QUOTA_EXCEEDED: but exit was not quota", exitCode: 5 },
    { message: "git fetch failed: remote unavailable", exitCode: 1 },
  ])("does not classify incidental or mismatched mention: $message", signal => {
    expect(classifyWorkspaceRecoveryCause(signal)).toBeNull();
  });

  it("produces a stable dedupe key for repeated signals", () => {
    const signal = { message: workspaceRecoveryFixtures[0]!.message, exitCode: 3 };
    const first = classifyWorkspaceRecoveryCause(signal);
    const second = classifyWorkspaceRecoveryCause({ ...signal });
    expect(first).toEqual(second);
    expect(first?.dedupeKey).toBe(buildRecoveryDedupeKey({
      kind: first!.kind,
      scope: first!.scope,
      cause: first!.cause,
    }));
  });
});
