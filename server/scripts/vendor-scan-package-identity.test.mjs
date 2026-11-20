import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { findRunnerExternalPackages } from "./verify-runner-vendor-dependencies.mjs";

let fixtureDir;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

it("normalizes external package identities and detects a new bare import", async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  fixtureDir = mkdtempSync(join(scratch, "vendor-scan-identity-"));
  const entry = join(fixtureDir, "index.js");
  const imports = [
    '@scope/alpha',
    '@scope/alpha/subpath',
    '@scope/alpha/another/path',
    '@scope/beta/subpath',
    '@other/alpha/subpath',
    'plain-package/deep/path',
  ].map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n");
  writeFileSync(entry, imports);

  const expected = new Set(["@scope/alpha", "@scope/beta", "@other/alpha", "plain-package"]);
  expect(await findRunnerExternalPackages([entry])).toEqual(expected);

  writeFileSync(entry, `${imports}\nimport "new-package";\n`);
  expect(await findRunnerExternalPackages([entry])).toEqual(new Set([...expected, "new-package"]));
});
