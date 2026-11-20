import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRunnerExternalPackages } from "./verify-runner-vendor-dependencies.mjs";

let fixtureDir;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("CommonJS vendor dependency scan", () => {
  it("finds literal and reachable child requires and detects one additional package", async () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
    fixtureDir = mkdtempSync(join(scratch, "vendor-scan-commonjs-"));
    const entry = join(fixtureDir, "entry.cjs");
    writeFileSync(join(fixtureDir, "child.cjs"), 'module.exports = require("cjs-child");\n');
    const base = 'module.exports = [require("cjs-alpha"), require("cjs-beta/subpath"), require("./child.cjs")];\n';
    writeFileSync(entry, base);

    await expect(findRunnerExternalPackages([entry])).resolves.toEqual(
      new Set(["cjs-alpha", "cjs-beta", "cjs-child"]),
    );

    writeFileSync(entry, base + 'module.exports.push(require("cjs-extra"));\n');
    await expect(findRunnerExternalPackages([entry])).resolves.toEqual(
      new Set(["cjs-alpha", "cjs-beta", "cjs-child", "cjs-extra"]),
    );
  });
});
