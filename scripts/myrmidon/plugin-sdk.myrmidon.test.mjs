import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = fileURLToPath(new URL("../generate-plugin-package-json.mjs", import.meta.url));

function fixture(run) {
  const scratch = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "plugin-sdk-"));
  const script = join(root, "scripts", "generate-plugin-package-json.mjs");
  const sdk = join(root, "packages", "plugins", "sdk", "package.json");
  const plugin = join(root, "plugin", "package.json");
  try {
    for (const path of [script, sdk, plugin]) mkdirSync(dirname(path), { recursive: true });
    copyFileSync(source, script);
    run({ script, sdk, plugin });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function generate({ script, plugin }) {
  const result = spawnSync(process.execPath, [script], { cwd: dirname(plugin), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Generated publishable plugin package\.json/);
  const bytes = readFileSync(plugin, "utf8");
  assert.ok(bytes.endsWith("\n"));
  return JSON.parse(bytes);
}

function assertDependencies(manifest, expected) {
  assert.deepEqual(manifest.dependencies, expected);
  for (const field of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.hasOwn(manifest, field), false, field);
  }
}

const extraSections = {
  devDependencies: { dev: "1" },
  optionalDependencies: { optional: "2" },
  peerDependencies: { peer: "3" },
};

test("publishing uses the SDK version and preserves external dependencies", () => {
  fixture((paths) => {
    writeJson(paths.sdk, { name: "@myrmidon/plugin-sdk", version: "1.2.3" });
    const cases = [
      { input: undefined, expected: { "@myrmidon/plugin-sdk": "1.2.3" } },
      { input: { "@myrmidon/plugin-sdk": "workspace:*" }, expected: { "@myrmidon/plugin-sdk": "1.2.3" } },
      { input: { "@myrmidon/plugin-sdk": "9.8.7", "@external/tool": "^4.5.6" }, expected: { "@myrmidon/plugin-sdk": "1.2.3", "@external/tool": "^4.5.6" } },
    ];
    for (const { input, expected } of cases) {
      writeJson(paths.plugin, { name: "fixture-plugin", version: "0.1.0", dependencies: input, ...extraSections });
      assertDependencies(generate(paths), expected);
    }
    writeJson(paths.sdk, { name: "@myrmidon/plugin-sdk", version: "2.3.4" });
    assertDependencies(generate(paths), { "@myrmidon/plugin-sdk": "2.3.4", "@external/tool": "^4.5.6" });
  });
});

test("the exact dependency oracle rejects workspace SDK and lost external dependencies", () => {
  fixture((paths) => {
    writeJson(paths.sdk, { name: "@myrmidon/plugin-sdk", version: "1.2.3" });
    const input = { name: "fixture-plugin", version: "0.1.0", dependencies: { "@myrmidon/plugin-sdk": "workspace:*", "@external/tool": "^4.5.6" } };
    const expected = { "@myrmidon/plugin-sdk": "1.2.3", "@external/tool": "^4.5.6" };
    writeJson(paths.plugin, input);
    assertDependencies(generate(paths), expected);

    const original = readFileSync(paths.script, "utf8");
    const mutations = [
      original.replace('"@myrmidon/plugin-sdk": sdkPackageJson.version,', '"@myrmidon/plugin-sdk": "workspace:*",'),
      original.replace('...(packageJson.dependencies ?? {}),', '...{},'),
    ];
    for (const mutated of mutations) {
      assert.notEqual(mutated, original);
      writeFileSync(paths.script, mutated);
      writeJson(paths.plugin, input);
      const output = generate(paths);
      assert.throws(() => assertDependencies(output, expected), assert.AssertionError);
    }
    writeFileSync(paths.script, original);
    writeJson(paths.plugin, input);
    assertDependencies(generate(paths), expected);
  });
});
