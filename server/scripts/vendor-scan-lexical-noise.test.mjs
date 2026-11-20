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

describe("vendor scan lexical noise", () => {
  it("ignores import-like comments and strings but detects a real replacement", async () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
    fixtureDir = mkdtempSync(join(scratch, "vendor-scan-lexical-"));
    const entry = join(fixtureDir, "entry.mjs");
    const noise = [
      'import "real-marker";',
      '// import "line-import"; require("line-require"); export * from "line-export";',
      '/* import "block-import"; require("block-require"); export * from "block-export"; */',
      'export const single = \'import "single-import"; require("single-require"); export * from "single-export";\';',
      'export const double = "import \'double-import\'; require(\'double-require\'); export * from \'double-export\';";',
      'export const template = `import "template-import"; require("template-require"); export * from "template-export";`;',
    ];
    writeFileSync(entry, noise.join("\n"));
    expect(await findRunnerExternalPackages([entry])).toEqual(new Set(["real-marker"]));

    noise[1] = 'import "replacement-marker";';
    writeFileSync(entry, noise.join("\n"));
    expect(await findRunnerExternalPackages([entry])).toEqual(new Set(["real-marker", "replacement-marker"]));
  });
});
