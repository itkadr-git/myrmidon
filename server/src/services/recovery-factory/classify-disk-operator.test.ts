import { buildRecoveryDedupeKey } from "@myrmidon/shared";
import { describe, expect, it } from "vitest";
import { classifyDiskRecoveryCause, classifyOperatorAction } from "./classify-disk-operator.js";

describe("classify disk/operator recovery signals", () => {
  it("classifies the observed disk signal families", () => {
    const types = [
      "host-disk:partition-critical:company:/var:2026-10-26",
      "host-disk:partition-warn", "host-disk:partition-refuse-open", "host-disk:partition-free-space",
      "host-disk:workspace-quota", "host-disk:workspace-quota-exceeded", "host-disk:workspace-quota-near-limit",
      "host-disk:inode-critical", "host-disk:inode-warn", "host-disk:docker-prune-required",
      "host-disk:artifact-retention", "host-disk:logs-retention", "host-disk:cache-retention",
      "host-disk:volume-quota", "host-disk:volume-quota-exceeded",
    ];
    expect(types.map((type) => classifyDiskRecoveryCause({ type })).filter(Boolean)).toHaveLength(15);
  });

  it("gives the nine OPE-8079 actions distinct keys", () => {
    const actions = ["restart-ci", "relay-branch", "restore-review-participant", "restore-execution-review", "restore-github-access", "restore-myr-ws", "restore-devbuild", "free-host-disk", "raise-host-quota"];
    const keys = actions.map((action) => classifyOperatorAction({ action, scope: "company/1" })?.dedupeKey);
    expect(new Set(keys).size).toBe(9);
    expect(keys.every(Boolean)).toBe(true);
  });

  it("returns null for unknown signals", () => {
    expect(classifyDiskRecoveryCause({ type: "host-disk:unrecognized" })).toBeNull();
    expect(classifyOperatorAction({ action: "unknown" })).toBeNull();
  });
});
