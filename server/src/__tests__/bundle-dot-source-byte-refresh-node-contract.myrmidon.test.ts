import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contract = fileURLToPath(new URL("../../../scripts/myrmidon/bundle-audit/import-report-dot-source-byte-refresh.myrmidon.test.mjs", import.meta.url));

describe("DOT source byte refresh contract", () => {
  it("runs the Node integration suite", () => {
    const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 70_000);
});
