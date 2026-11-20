import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contract = fileURLToPath(new URL("../../../scripts/release-version-rewrite-sections.myrmidon.test.mjs", import.meta.url));

describe("release version dependency section contract", () => {
  it("passes the Node integration test", () => {
    const result = spawnSync(process.execPath, ["--test", contract], { encoding: "utf8", timeout: 60_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 70_000);
});
