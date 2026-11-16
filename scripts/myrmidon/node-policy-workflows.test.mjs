import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../check-node-version-policy.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir();
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

function withFixture(run) {
  const root = mkdtempSync(path.join(scratch, "node-policy-workflows-"));
  const put = (name, text) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const script = path.join(root, "scripts/check-node-version-policy.mjs");
  const check = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
  try {
    mkdirSync(path.dirname(script), { recursive: true });
    copyFileSync(source, script);
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    put("package.json", JSON.stringify({ engines: { node: ">=24.11.0" } }));
    for (const [name, text] of Object.entries(fragments)) put(name, text);
    const baseline = check();
    assert.equal(baseline.status, 0, baseline.stderr || String(baseline.error));
    run({ put, check });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const extension of ["yml", "yaml"]) {
  for (const [label, value] of [["bare", "24"], ["single quoted", "'24'"], ["double quoted", '"24"']]) {
    test(`${extension} accepts ${label} Node 24`, () => withFixture(({ put, check }) => {
      put(`.github/workflows/valid.${extension}`, `node-version: ${value}\n`);
      const result = check();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Node version policy check passed/);
    }));
  }
  for (const version of ["20", "22", "24.x"]) {
    test(`${extension} rejects Node ${version} at a nested path`, () => withFixture(({ put, check }) => {
      const file = `.github/workflows/nested/policy.${extension}`;
      put(file, `node-version: ${version}\n`);
      const result = check();
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(`${file}: node-version must be 24, found ${version}`), result.stderr);
    }));
  }
  test(`${extension} accepts Node 24 before an inline comment`, () => withFixture(({ put, check }) => {
    put(`.github/workflows/comment.${extension}`, "node-version: 24 # pinned major\n");
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node version policy check passed/);
  }));
  test(`${extension} rejects Node 20 before an inline comment`, () => withFixture(({ put, check }) => {
    const file = `.github/workflows/comment.${extension}`;
    put(file, "node-version: 20 # wrong major\n");
    const result = check();
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`${file}: node-version must be 24, found 20`), result.stderr);
  }));
}

for (const extension of ["txt", "yml.bak", "YAML", "json"]) {
  test(`ignores unrelated ${extension} extension`, () => withFixture(({ put, check }) => {
    put(`.github/workflows/nested/ignored.${extension}`, "node-version: 20\n");
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node version policy check passed/);
  }));
}

test("accumulates every wrong match across files and ignores valid matches", () => withFixture(({ put, check }) => {
  const first = ".github/workflows/a.yml";
  const second = ".github/workflows/deep/b.yaml";
  put(first, "node-version: 20\nnode-version: 24\nnode-version: '22'\n");
  put(second, 'node-version: "24.x"\n');
  const result = check();
  assert.equal(result.status, 1, result.stderr);
  const diagnostics = result.stderr.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(diagnostics.sort(), [
    `- ${first}: node-version must be 24, found 20`,
    `- ${first}: node-version must be 24, found 22`,
    `- ${second}: node-version must be 24, found 24.x`,
  ].sort());
}));
