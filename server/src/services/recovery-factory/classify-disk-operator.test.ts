import { describe, expect, it } from "vitest";
import {
  buildRecoveryDedupeKey,
  classifyDiskRecoveryCause,
  classifyOperatorAction,
} from "./classify-disk-operator.js";
import type { RecoverySignal } from "./classify-disk-operator.js";
import { diskRecoveryFixtures, operatorRecoveryFixtures } from "./__fixtures__/disk-operator-signals.js";

describe("classifyDiskRecoveryCause", () => {
  it.each(diskRecoveryFixtures)("classifies $source", fixture => {
    if ("expected" in fixture) {
      expect(classifyDiskRecoveryCause(fixture.signal)).toBe(fixture.expected);
      return;
    }
    expect(classifyDiskRecoveryCause(fixture.signal)).toEqual({ kind: "disk_space", cause: fixture.cause, scope: fixture.scope });
  });

  it.each([
    { message: "devbuild rsync: write failed: No space left on device" },
    { host: "devbuild", freeBytes: 9 * 1024 ** 3 },
    { host: "vm-core", path: "/", usedPct: 90 },
    { host: "vm-core", path: "/", freeBytes: 19 * 1024 ** 3 },
    { path: "/workspace/bot", message: "BOT_DISK_QUOTA_EXCEEDED: hard disk pressure" },
    { path: "/workspace/OPE-1", message: "write failed: ENOSPC" },
    { path: "/workspace/OPE-2", message: "myr-ws quota exceeded" },
    { message: "container OOMKilled: cgroup memory.max reached" },
    { path: "/tmp", message: "tmpfs is full in container" },
    { message: "docker pull failed: no space left while extracting image" },
    { message: "docker system df reports storage above configured threshold" },
  ])("classifies approved signal $message", signal => {
    expect(classifyDiskRecoveryCause(signal)).not.toBeNull();
  });

  it.each([
    { message: "disk full in unrelated documentation" },
    { host: "devbuild", freeBytes: 10 * 1024 ** 3 },
    { path: "/", usedPct: 89, freeBytes: 30 * 1024 ** 3 },
    { path: "/workspace/x", message: "quota exceeded and OOMKilled" },
    { host: "devbuild", path: "/", usedPct: 95, freeBytes: 1 },
    { message: "unknown storage failure" },
    { exitCode: 137 },
    { exitCode: 143 },
    { exitCode: 28 },
    { exitCode: 29 },
  ])("returns null for unknown, below-threshold, or ambiguous disk signals", signal => {
    expect(classifyDiskRecoveryCause(signal)).toBeNull();
  });
});

describe("classifyOperatorAction", () => {
  it.each(operatorRecoveryFixtures)("classifies $source", ({ signal, cause }) => {
    expect(classifyOperatorAction(signal)).toEqual({ kind: "operator_action", cause, scope: "operator" });
  });

  it.each([
    { action: "unrecognized" },
    { message: "rerun CI and route the review to another reviewer" },
    { message: "operator may inspect the task" },
    { action: "restart-ci" },
    { action: "relay-branch" },
    { message: "configure CI access and route review" },
  ])("returns null for unknown or ambiguous actions", signal => {
    expect(classifyOperatorAction(signal)).toBeNull();
  });
});

describe("buildRecoveryDedupeKey", () => {
  it("uses the first available identity in PR, head SHA, issue order", () => {
    const result = { kind: "operator_action" as const, cause: "ci_rerun", scope: "operator" };
    const signals = [
      { prNumber: 42, headSha: "abc", issueId: "OPE-1" },
      { headSha: "abc", issueId: "OPE-1" },
      { issueId: "OPE-1" },
    ];
    const keys = signals.map(signal => buildRecoveryDedupeKey(result, signal));
    expect(new Set(keys).size).toBe(3);
  });

  it("classifies nine distinct OPE-8079 action inputs as nine unique dedupe keys", () => {
    const actionSignals: RecoverySignal[] = [
      { action: "ci_rerun", issueId: "OPE-7969" },
      { action: "ci_access", issueId: "OPE-7710" },
      { action: "review_route", issueId: "OPE-7590" },
      { action: "review_route", issueId: "OPE-6871" },
      { action: "review_participant_restore", issueId: "OPE-7225" },
      { action: "branch_relay", issueId: "OPE-7533" },
      { action: "head_decision", issueId: "OPE-6001" },
      { action: "head_decision", issueId: "OPE-7265" },
      { action: "infra_config", issueId: "OPE-7975" },
    ];
    const keys = actionSignals.map(signal => {
      const result = classifyOperatorAction(signal)!;
      return buildRecoveryDedupeKey(result, signal);
    });
    expect(new Set(keys).size).toBe(9);
  });

  it("uses an empty identity when none is supplied", () => {
    expect(buildRecoveryDedupeKey(
      { kind: "disk_space", cause: "host_root_low", scope: "vmcore_root" },
      {},
    )).toBe("disk_space:host_root_low:vmcore_root:");
  });
});
