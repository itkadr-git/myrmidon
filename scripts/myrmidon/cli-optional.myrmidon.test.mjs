import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = [
  "cli", "packages/db", "packages/shared", "packages/adapter-utils",
  "packages/adapters/claude-local", "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway", "packages/adapters/hermes",
  "packages/adapters/opencode-local", "packages/adapters/openclaw-gateway",
];

function generate(workspaceManifests, nativeOptional) {
  const scratch = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "cli-optional-"));
  try {
    const write = (path, data) => {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    };
    mkdirSync(join(root, "scripts"));
    for (const name of ["generate-npm-package-json.mjs", "cli-bundled-npm-dependencies.mjs"]) {
      copyFileSync(join(scripts, name), join(root, "scripts", name));
    }
    for (const path of workspaces) {
      write(`${path}/package.json`, JSON.stringify(workspaceManifests[path] ?? {}));
    }
    const native = { name: "embedded-postgres", main: "dist/index.js" };
    if (nativeOptional !== undefined) native.optionalDependencies = nativeOptional;
    write("packages/db/node_modules/embedded-postgres/package.json", JSON.stringify(native));
    write("packages/db/node_modules/embedded-postgres/dist/index.js", "");
    const result = spawnSync(process.execPath, [join(root, "scripts/generate-npm-package-json.mjs")], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Generated publishable package\.json/);
    assert.equal(result.stderr, "");
    return readFileSync(join(root, "cli/package.json"), "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cli = { name: "fixture-cli", version: "1.2.3" };

function expected(dependencies, optionalDependencies) {
  const manifest = { name: "fixture-cli", version: "1.2.3", engines: { node: ">=24.11.0" }, dependencies };
  if (optionalDependencies !== undefined) manifest.optionalDependencies = optionalDependencies;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

test("merges workspace optionals in order and applies native optionals last", () => {
  const output = generate({
    cli: { ...cli, dependencies: { shared: "1.0.0", plain: "2.0.0" }, optionalDependencies: { shared: "3.0.0", choice: "1", native: "workspace" } },
    "packages/db": { optionalDependencies: { choice: "2", database: "4" } },
    "packages/adapters/hermes": { optionalDependencies: { choice: "3", native: "later-workspace" } },
  }, { native: "native-wins", platform: "5" });
  assert.equal(output, expected({ plain: "2.0.0", shared: "1.0.0" }, {
    choice: "3", database: "4", native: "native-wins", platform: "5", shared: "3.0.0",
  }));
});

test("accepts native package without optionalDependencies", () => {
  assert.equal(generate({ cli: { ...cli, optionalDependencies: { workspace: "1" } } }),
    expected({}, { workspace: "1" }));
});

test("omits optionalDependencies when all sources are empty or absent", () => {
  assert.equal(generate({ cli, "packages/db": { optionalDependencies: {} } }), expected({}));
});

test("includes optionalDependencies when only native payload supplies them", () => {
  assert.equal(generate({ cli }, { "@native/linux": "7.0.0" }), expected({}, { "@native/linux": "7.0.0" }));
});
