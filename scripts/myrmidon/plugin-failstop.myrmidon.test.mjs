import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("../generate-plugin-package-json.mjs", import.meta.url));
const scratch = join(homedir(), ".cache", "myrmidon-tests");
const pluginInput = '{\n  "name": "fixture-plugin",\n  "version": "1.2.3",\n  "exports": "./source.js",\n  "publishConfig": {"main": "./dist/index.js", "types": "./dist/index.d.ts", "exports": "./dist/index.js"},\n  "files": ["dist"],\n  "dependencies": {"other": "^2", "@myrmidon/plugin-sdk": "workspace:*"},\n  "devDependencies": {"test-only": "1"}\n}\n';
const sdkInput = '{"name":"@myrmidon/plugin-sdk","version":"4.5.6"}\n';

function withFixture(run) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "plugin-failstop-"));
  try {
    const script = join(root, "scripts", "generate-plugin-package-json.mjs");
    const plugin = join(root, "plugin", "package.json");
    const sdk = join(root, "packages", "plugins", "sdk", "package.json");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(plugin), { recursive: true });
    mkdirSync(dirname(sdk), { recursive: true });
    copyFileSync(source, script);
    run({ root, script, plugin, sdk });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshot(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function invoke(fixture) {
  const result = spawnSync(process.execPath, [fixture.script], { cwd: dirname(fixture.plugin), encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

function assertFailure(fixture, diagnostic) {
  const beforePlugin = snapshot(fixture.plugin);
  const beforeSdk = snapshot(fixture.sdk);
  const result = invoke(fixture);
  assert.notEqual(result.status, 0, "generator must fail");
  assert.equal(result.signal, null);
  assert.match(result.stderr, diagnostic);
  assert.equal(result.stdout, "");
  assert.deepEqual(snapshot(fixture.plugin), beforePlugin, "plugin bytes must not change");
  assert.deepEqual(snapshot(fixture.sdk), beforeSdk, "SDK bytes must not change");
}

for (const scenario of [
  { name: "missing plugin manifest", plugin: null, sdk: sdkInput, diagnostic: /No package\.json found in plugin directory/ },
  { name: "malformed plugin manifest", plugin: '{"name":', sdk: sdkInput, diagnostic: /SyntaxError/ },
  { name: "missing SDK manifest", plugin: pluginInput, sdk: null, diagnostic: /ENOENT.*package\.json/ },
  { name: "malformed SDK manifest", plugin: pluginInput, sdk: '{"version":', diagnostic: /SyntaxError/ },
]) {
  test(scenario.name, () => withFixture((fixture) => {
    if (scenario.plugin !== null) writeFileSync(fixture.plugin, scenario.plugin);
    if (scenario.sdk !== null) writeFileSync(fixture.sdk, scenario.sdk);
    assertFailure(fixture, scenario.diagnostic);
  }));
}

test("valid manifests produce the expected publish manifest", () => withFixture((fixture) => {
  writeFileSync(fixture.plugin, pluginInput);
  writeFileSync(fixture.sdk, sdkInput);
  const result = invoke(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Generated publishable plugin package\.json for fixture-plugin/);
  assert.deepEqual(JSON.parse(readFileSync(fixture.plugin, "utf8")), {
    name: "fixture-plugin",
    version: "1.2.3",
    exports: "./dist/index.js",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    publishConfig: { main: "./dist/index.js", types: "./dist/index.d.ts", exports: "./dist/index.js" },
    files: ["dist"],
    dependencies: { other: "^2", "@myrmidon/plugin-sdk": "4.5.6" },
  });
  assert.equal(readFileSync(fixture.sdk, "utf8"), sdkInput);
}));

test("negative controls detect swallowed errors and premature writes", () => {
  for (const mutation of ["swallow", "write"]) {
    withFixture((fixture) => {
      writeFileSync(fixture.plugin, pluginInput);
      const original = readFileSync(fixture.script, "utf8");
      const changed = mutation === "swallow"
        ? original.replace('const sdkPackageJson = JSON.parse(readFileSync(sdkPackageJsonPath, "utf8"));', 'process.exit(0);')
        : original.replace('const sdkPackageJson = JSON.parse(readFileSync(sdkPackageJsonPath, "utf8"));', 'writeFileSync(packageJsonPath, "{}");\nconst sdkPackageJson = JSON.parse(readFileSync(sdkPackageJsonPath, "utf8"));');
      assert.notEqual(changed, original);
      writeFileSync(fixture.script, changed);
      assert.throws(() => assertFailure(fixture, /ENOENT.*package\.json/), mutation === "swallow" ? /generator must fail/ : /plugin bytes must not change/);
    });
  }
});
