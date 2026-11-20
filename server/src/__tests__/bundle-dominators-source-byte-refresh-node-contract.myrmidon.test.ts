import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("bundle dominators source byte refresh node contract", () => {
  it("runs the isolated node:test suite", () => {
    const script = fileURLToPath(new URL("../../../scripts/myrmidon/bundle-audit/import-report-dominators-source-byte-refresh.myrmidon.test.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", script], { encoding: "utf8", timeout: 30_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# pass 1\b/);
  }, 35_000);
});
