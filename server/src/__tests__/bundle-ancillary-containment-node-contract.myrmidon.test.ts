import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("bundle ancillary containment node contract", () => {
  it("passes the behavioral node suite", () => {
    const suite = fileURLToPath(new URL("../../../scripts/bundle-ancillary-containment.myrmidon.test.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--test", suite], { encoding: "utf8", timeout: 60000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 70000);
});
