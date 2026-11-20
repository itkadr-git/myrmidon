import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const generator = resolve(dirname(fileURLToPath(import.meta.url)), "../generate-plugin-package-json.mjs");
const fullInput = {
  name: "@example/plugin", version: "1.2.3", description: "A fixture", license: "MIT",
  homepage: "https://example.com/plugin", bugs: { url: "https://example.com/issues" },
  repository: { type: "git", url: "https://example.com/repo.git", directory: "plugins/example" },
  type: "module", files: ["dist", "README.md"],
  paperclipPlugin: { id: "example", capabilities: ["read", "write"], settings: { enabled: true } },
  keywords: ["plugin", "fixture"], scripts: { build: "private-build" },
  devDependencies: { builder: "1.0.0" }, engines: { node: ">=24" },
  custom: { secret: "build-only" }, source: "src/index.ts",
};
const fullExpected = {
  name: "@example/plugin", version: "1.2.3", description: "A fixture", license: "MIT",
  homepage: "https://example.com/plugin", bugs: { url: "https://example.com/issues" },
  repository: { type: "git", url: "https://example.com/repo.git", directory: "plugins/example" },
  type: "module", publishConfig: {}, files: ["dist", "README.md"],
  paperclipPlugin: { id: "example", capabilities: ["read", "write"], settings: { enabled: true } },
  keywords: ["plugin", "fixture"], dependencies: { "@myrmidon/plugin-sdk": "4.5.6" },
};

function generate(input, mutateScript) {
  const scratch = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "plugin-metadata-"));
  try {
    const scripts = join(root, "scripts");
    const sdk = join(root, "packages", "plugins", "sdk");
    const plugin = join(root, "plugin");
    for (const dir of [scripts, sdk, plugin]) mkdirSync(dir, { recursive: true });
    const script = join(scripts, "generate-plugin-package-json.mjs");
    copyFileSync(generator, script);
    if (mutateScript) {
      const original = readFileSync(script, "utf8");
      const changed = mutateScript(original);
      assert.notEqual(changed, original, "negative control must change the fixture script");
      writeFileSync(script, changed);
    }
    writeFileSync(join(sdk, "package.json"), JSON.stringify({ version: "4.5.6" }));
    const manifest = join(plugin, "package.json");
    writeFileSync(manifest, JSON.stringify(input));
    const result = spawnSync(process.execPath, [script], { cwd: plugin, encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(manifest, "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertManifest(actual, expected) {
  assert.equal(actual, `${JSON.stringify(expected, null, 2)}\n`);
}

test("preserves complete plugin metadata and removes build-only fields", () => {
  assertManifest(generate(fullInput), fullExpected);
});

test("omits absent optional metadata rather than writing null", () => {
  assertManifest(generate({ name: "minimal", version: "1.0.0" }), {
    name: "minimal", version: "1.0.0", publishConfig: {},
    dependencies: { "@myrmidon/plugin-sdk": "4.5.6" },
  });
});

test("negative controls reject missing plugin metadata and leaked scripts", () => {
  for (const mutate of [
    (source) => source.replace("  paperclipPlugin: packageJson.paperclipPlugin,\n", ""),
    (source) => source.replace("  keywords: packageJson.keywords,\n", "  keywords: packageJson.keywords,\n  scripts: packageJson.scripts,\n"),
  ]) {
    const actual = generate(fullInput, mutate);
    assert.throws(() => assertManifest(actual, fullExpected), assert.AssertionError);
  }
});
