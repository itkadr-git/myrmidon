import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "vitest";

describe("release package version reload node contract", () => {
  it("passes the isolated node test suite", () => {
    execFileSync(process.execPath, ["--test", resolve(__dirname, "../../../scripts/release-package-version-reload.myrmidon.test.mjs")], {
      timeout: 30_000,
      stdio: "pipe",
    });
  });
});
