import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testFile = fileURLToPath(new URL("../../../scripts/myrmidon/ci/build-deps-lock-recovery.myrmidon.test.mjs", import.meta.url));

describe("build dependency lock recovery", () => {
  it("runs the node lock recovery contract", () => {
    const result = spawnSync(process.execPath, ["--test", testFile], { encoding: "utf8", timeout: 30_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 35_000);
});
