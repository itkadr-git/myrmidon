import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const policy = fileURLToPath(new URL("../check-node-version-policy.mjs", import.meta.url));
const fragments = [
  [".nvmrc", "24"],
  ["packages/shared/src/node-version.ts", 'MINIMUM_NODE_VERSION = "24.11.0"'],
  ["scripts/install.sh", 'MIN_NODE_VERSION="${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}"'],
  ["scripts/install.sh", "MIN_NODE_MAJOR=24"],
  ["scripts/install.sh", "MIN_NODE_MINOR=11"],
  ["scripts/install.sh", "DEFAULT_NODE_MAJOR=24"],
  ["docker/agent-runtime/Dockerfile.base", "ARG NODE_VERSION=24"],
  ["packages/adapter-utils/src/sandbox-install-command.ts", 'NODE_VERSION="v24.11.0"'],
  ["packages/plugins/sandbox-providers/exe-dev/src/plugin.ts", "nodesource.com/setup_24.x"],
  ["packages/plugins/sandbox-providers/modal/src/manifest.ts", 'default: "node:24"'],
  ["cli/esbuild.config.mjs", 'target: "node24"'],
  ["packages/plugins/sdk/src/bundlers.ts", 'target: "node24"'],
  ["scripts/generate-npm-package-json.mjs", 'engines: { node: ">=24.11.0" }'],
];
const excluded = [".git", ".paperclip", "coverage", "data", "dist", "node_modules"];

function put(root, name, content) {
  const destination = path.join(root, name);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function run(root) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-node-version-policy.mjs")], { encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

function withFixture(callback) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir();
  const root = mkdtempSync(path.join(base, "node-policy-"));
  try {
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    copyFileSync(policy, path.join(root, "scripts/check-node-version-policy.mjs"));
    put(root, "package.json", JSON.stringify({ engines: { node: ">=24.11.0" } }));
    const sources = new Map();
    for (const [name, fragment] of fragments) sources.set(name, [...(sources.get(name) || []), fragment]);
    for (const [name, lines] of sources) put(root, name, `${lines.join("\n")}\n`);
    const baseline = run(root);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Node version policy check passed/);
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a complete isolated policy fixture", () => withFixture(() => {}));

for (const [name, fragment] of fragments) {
  test(`rejects missing fragment ${name}: ${fragment}`, () => withFixture((root) => {
    const file = path.join(root, name);
    const lines = readFileSync(file, "utf8").split("\n");
    assert.equal(lines.filter((line) => line === fragment).length, 1);
    put(root, name, lines.filter((line) => line !== fragment).join("\n"));
    const result = run(root);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`${name}: missing Node 24 policy fragment ${JSON.stringify(fragment)}`), result.stderr);
  }));
}

for (const name of excluded) {
  test(`ignores invalid nested manifests under ${name}`, () => withFixture((root) => {
    put(root, `nested/${name}/deeper/package.json`, JSON.stringify({ engines: { node: "18" } }));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node version policy check passed/);
  }));
}

test("rejects an invalid manifest in a regular nested directory", () => withFixture((root) => {
  put(root, "nested/ordinary/package.json", JSON.stringify({ engines: { node: "18" } }));
  const result = run(root);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes("nested/ordinary/package.json: engines.node must be >=24.11.0, found 18"), result.stderr);
}));
