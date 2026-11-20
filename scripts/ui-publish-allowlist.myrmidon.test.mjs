import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const generator = join(dirname(fileURLToPath(import.meta.url)), "generate-ui-package-json.mjs");
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test");

function generate(input) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "ui-publish-allowlist-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "ui"));
    mkdirSync(join(root, "decoy"));
    const script = join(root, "scripts", "generate-ui-package-json.mjs");
    const manifest = join(root, "ui", "package.json");
    cpSync(generator, script);
    writeFileSync(manifest, JSON.stringify(input));
    const result = spawnSync(process.execPath, [script], { cwd: join(root, "decoy"), encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "  ✓ Generated publishable UI package.json\n");
    assert.equal(result.stderr, "");
    const bytes = readFileSync(manifest, "utf8");
    return { bytes, manifest: JSON.parse(bytes) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("UI publish manifest allowlist", () => {
  it("keeps only metadata and overrides publish fields without running lifecycle scripts", () => {
    const metadata = {
      name: "myrmidon-ui-fixture",
      version: "1.2.3",
      description: "UI fixture",
      license: "MIT",
      homepage: "https://example.com/",
      bugs: { url: "https://example.com/issues" },
      repository: { type: "git", url: "https://example.com/repo.git" },
      type: "module",
    };
    const input = {
      ...metadata,
      dependencies: { dependency: "1" },
      devDependencies: { development: "2" },
      optionalDependencies: { optional: "3" },
      peerDependencies: { peer: "4" },
      scripts: { preinstall: "exit 91", install: "exit 92", postinstall: "exit 93", prepare: "exit 94" },
      private: true,
      workspaces: ["packages/*"],
      exports: { ".": "./source.js" },
      bin: { fixture: "./cli.js" },
      custom: { unsafe: true },
      files: ["source", "secrets"],
      publishConfig: { access: "restricted", registry: "https://example.com/" },
    };
    const expected = { ...metadata, files: ["dist"], publishConfig: { access: "public" } };
    const output = generate(input);
    assert.deepEqual(output.manifest, expected);
    assert.equal(output.bytes, `${JSON.stringify(expected, null, 2)}\n`);
  });

  it("omits absent metadata instead of emitting extra keys", () => {
    const expected = { files: ["dist"], publishConfig: { access: "public" } };
    const output = generate({ private: true, dependencies: { unwanted: "1" } });
    assert.deepEqual(output.manifest, expected);
    assert.equal(output.bytes, `${JSON.stringify(expected, null, 2)}\n`);
  });
});
