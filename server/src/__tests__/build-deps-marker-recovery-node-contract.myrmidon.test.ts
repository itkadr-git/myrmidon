import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const suite = path.join(repoRoot, "scripts/myrmidon/ci/build-deps-marker-recovery.myrmidon.test.mjs");

describe("build dependency marker recovery node contract", () => {
  test("executes the marker recovery suite successfully", () => {
    expect(() => execFileSync(process.execPath, ["--test", suite], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env: { ...process.env },
    })).not.toThrow();
  }, 35_000);
});
