import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("externals source byte refresh node contract", () => {
  it("runs the real scanner and consumer contract", () => {
    const result = spawnSync(process.execPath, ["--test", resolve(process.cwd(), "scripts/myrmidon/bundle-audit/import-report-externals-source-byte-refresh.myrmidon.test.mjs")], {
      encoding: "utf8",
      timeout: 30000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
  }, 40000);
});
