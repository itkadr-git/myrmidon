import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contract = fileURLToPath(new URL("../../../scripts/myrmidon/ci/build-deps-config-invalidation.myrmidon.test.mjs", import.meta.url));

describe("build dependency configuration invalidation contract", () => {
  it("passes the Node integration tests", () => {
    const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 70_000);
});
