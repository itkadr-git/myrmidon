import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL("../../../", import.meta.url)), "scripts");
const contract = join(root, "release-package-order-reload.myrmidon.test.mjs");

describe("release package order reload node contract", () => {
  it("runs the graph transitions in one bounded node:test process", () => {
    const result = spawnSync(process.execPath, ["--test", contract], {
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("reloads the publication graph");
  }, 70_000);
});
