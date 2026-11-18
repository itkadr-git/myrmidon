import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL("../../../", import.meta.url)), "scripts");
const contract = join(root, "myrmidon/bundle-audit/import-report-edge-diff-source-byte-refresh.myrmidon.test.mjs");

describe("edge diff source byte refresh node contract", () => {
  it("runs the bounded A/B/C/A scanner and consumer integration", () => {
    const result = spawnSync(process.execPath, ["--test", contract], {
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("refreshes source bytes across A B C A");
  }, 70_000);
});
