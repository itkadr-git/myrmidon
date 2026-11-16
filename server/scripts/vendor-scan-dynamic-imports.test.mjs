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

describe("vendor dependency scan with dynamic imports", () => {
  it("includes literal npm imports and reachable relative imports, but not an unreachable sibling", async () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
    fixtureDir = mkdtempSync(join(scratch, "vendor-scan-dynamic-"));
    const entry = join(fixtureDir, "entry.js");
    writeFileSync(entry, [
      'export const alpha = () => import("dynamic-alpha");',
      'export const beta = () => import("dynamic-beta/subpath");',
      'export const child = () => import("./child.js");',
    ].join("\n"));
    writeFileSync(join(fixtureDir, "child.js"), 'import "child-side-effect";\n');
    writeFileSync(join(fixtureDir, "unreachable.js"), 'import "unreachable-sibling";\n');

    expect(await findRunnerExternalPackages([entry])).toEqual(
      new Set(["dynamic-alpha", "dynamic-beta", "child-side-effect"]),
    );
  });
});
