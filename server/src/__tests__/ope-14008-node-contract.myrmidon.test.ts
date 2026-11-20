import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testFile = fileURLToPath(new URL("../../../scripts/myrmidon/ci/standalone-package-selection.myrmidon.test.mjs", import.meta.url));

describe("OPE-14008 standalone package selection", () => {
  it("executes the node contract tests", () => {
    const output = execFileSync(process.execPath, ["--test", "--test-reporter=tap", testFile], { encoding: "utf8", timeout: 60000 });
    expect(output).toMatch(/# pass 2\b/);
    expect(output).toMatch(/# fail 0\b/);
  }, 70000);
});
