import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("../check-node-version-policy.mjs", import.meta.url));
const engine = ">=24.11.0";
const types = "^24.0.0";
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const fragments = {
  ".nvmrc": "24",
  "packages/shared/src/node-version.ts": 'MINIMUM_NODE_VERSION = "24.11.0"',
  "scripts/install.sh": 'MIN_NODE_VERSION="${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}"\nMIN_NODE_MAJOR=24\nMIN_NODE_MINOR=11\nDEFAULT_NODE_MAJOR=24',
  "docker/agent-runtime/Dockerfile.base": "ARG NODE_VERSION=24",
  "packages/adapter-utils/src/sandbox-install-command.ts": 'NODE_VERSION="v24.11.0"',
  "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts": "nodesource.com/setup_24.x",
  "packages/plugins/sandbox-providers/modal/src/manifest.ts": 'default: "node:24"',
  "cli/esbuild.config.mjs": 'target: "node24"',
  "packages/plugins/sdk/src/bundlers.ts": 'target: "node24"',
  "scripts/generate-npm-package-json.mjs": 'engines: { node: ">=24.11.0" }',
};

function fixture(callback) {
  const root = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), "node-policy-"));
  const write = (name, content) => {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const manifest = (name, value) => write(name, JSON.stringify(value));
  const script = path.join(root, "scripts/check-node-version-policy.mjs");
  try {
    mkdirSync(path.dirname(script), { recursive: true });
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    copyFileSync(source, script);
    for (const [name, content] of Object.entries(fragments)) write(name, content);
    manifest("package.json", { engines: { node: engine } });
    const run = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(baseline.stdout.trim(), "Node version policy check passed (Node >=24.11.0, @types/node 24.x).");
    callback({ write, manifest, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "Node version policy check passed (Node >=24.11.0, @types/node 24.x).");
}

function fails(result, diagnostics) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.stderr.trim().split("\n").sort(), ["Node version policy check failed:", ...diagnostics.map((d) => `- ${d}`)].sort());
}

test("valid root and nested engines pass", () => fixture(({ manifest, run }) => {
  manifest("packages/a/package.json", { engines: { node: engine } });
  succeeds(run());
}));

for (const [label, value, found] of [
  ["older minimum", ">=22.0.0", ">=22.0.0"],
  ["different range", "^24.11.0", "^24.11.0"],
  ["newer minimum", ">=25.0.0", ">=25.0.0"],
  ["missing node", undefined, "missing"],
]) {
  test(`rejects ${label} engine in nested manifest`, () => fixture(({ manifest, run }) => {
    manifest("packages/a/package.json", { engines: { node: value } });
    fails(run(), [`packages/a/package.json: engines.node must be ${engine}, found ${found}`]);
  }));
}

test("rejects absent engines in root manifest", () => fixture(({ manifest, run }) => {
  manifest("package.json", {});
  fails(run(), [`package.json: engines.node must be ${engine}, found missing`]);
}));

for (const section of sections) {
  test(`accepts exact @types/node in ${section}`, () => fixture(({ manifest, run }) => {
    manifest("packages/a/package.json", { engines: { node: engine }, [section]: { "@types/node": types } });
    succeeds(run());
  }));
  test(`accepts absent @types/node in ${section}`, () => fixture(({ manifest, run }) => {
    manifest("packages/a/package.json", { engines: { node: engine }, [section]: { other: "1.0.0" } });
    succeeds(run());
  }));
  for (const wrong of ["^22.0.0", "24.0.0", "^25.0.0"]) {
    test(`rejects ${section} @types/node ${wrong}`, () => fixture(({ manifest, run }) => {
      manifest("packages/a/package.json", { engines: { node: engine }, [section]: { "@types/node": wrong } });
      fails(run(), [`packages/a/package.json: ${section}.@types/node must be ${types}, found ${wrong}`]);
    }));
  }
}

test("accumulates errors across manifests and sections", () => fixture(({ manifest, run }) => {
  manifest("package.json", { engines: { node: "22" }, dependencies: { "@types/node": "22" }, peerDependencies: { "@types/node": "25" } });
  manifest("packages/a/package.json", { devDependencies: { "@types/node": "23" } });
  fails(run(), [
    `package.json: engines.node must be ${engine}, found 22`,
    `package.json: dependencies.@types/node must be ${types}, found 22`,
    `package.json: peerDependencies.@types/node must be ${types}, found 25`,
    `packages/a/package.json: engines.node must be ${engine}, found missing`,
    `packages/a/package.json: devDependencies.@types/node must be ${types}, found 23`,
  ]);
}));

test("ignores non-package JSON even when malformed", () => fixture(({ write, run }) => {
  write("packages/a/not-package.json", "not valid JSON");
  succeeds(run());
}));
