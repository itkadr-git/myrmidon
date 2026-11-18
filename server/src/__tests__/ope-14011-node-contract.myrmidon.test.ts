import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone SDK build order CLI contract", () => {
  it("executes the node contract suite", () => {
    const testFile = resolve(import.meta.dirname, "../../../scripts/myrmidon/ci/standalone-sdk-build-order.myrmidon.test.mjs");
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], { encoding: "utf8", timeout: 45000 });
    expect(result.error?.message, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# pass 1\b/);
    expect(result.stdout).toMatch(/# fail 0\b/);
  }, 50000);
});
