import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("plugin discovery symlink boundary node contract", () => {
  it("passes the standalone node test", () => {
    const result = spawnSync(process.execPath, ["--test", resolve(process.cwd(), "scripts/myrmidon/ci/plugin-discovery-symlink-boundary.myrmidon.test.mjs")], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
