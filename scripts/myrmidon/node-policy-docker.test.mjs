import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../check-node-version-policy.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir();
const success = "Node version policy check passed (Node >=24.11.0, @types/node 24.x).\n";

function write(root, name, content) {
  const target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function run(root) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-node-version-policy.mjs")], { encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

function checkResult(result, failures) {
  assert.equal(result.status, failures.length ? 1 : 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, failures.length ? "" : success);
  assert.equal(result.stderr, failures.length ? `Node version policy check failed:\n${failures.map((failure) => `- ${failure}\n`).join("")}` : "");
}

function fixture(action) {
  const root = mkdtempSync(path.join(scratch, "node-policy-docker-"));
  try {
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    copyFileSync(script, path.join(root, "scripts/check-node-version-policy.mjs"));
    const files = {
      "package.json": JSON.stringify({ engines: { node: ">=24.11.0" } }),
      ".nvmrc": "24\n",
      "packages/shared/src/node-version.ts": 'MINIMUM_NODE_VERSION = "24.11.0"',
      "scripts/install.sh": 'MIN_NODE_VERSION="${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}"\nMIN_NODE_MAJOR=24\nMIN_NODE_MINOR=11\nDEFAULT_NODE_MAJOR=24\n',
      "docker/agent-runtime/Dockerfile.base": "ARG NODE_VERSION=24\n",
      "packages/adapter-utils/src/sandbox-install-command.ts": 'NODE_VERSION="v24.11.0"',
      "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts": "nodesource.com/setup_24.x",
      "packages/plugins/sandbox-providers/modal/src/manifest.ts": 'default: "node:24"',
      "cli/esbuild.config.mjs": 'target: "node24"',
      "packages/plugins/sdk/src/bundlers.ts": 'target: "node24"',
      "scripts/generate-npm-package-json.mjs": 'engines: { node: ">=24.11.0" }',
    };
    for (const [name, content] of Object.entries(files)) write(root, name, content);
    checkResult(run(root), []);
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const imageError = (file, tag) => `${file}: Node base image must use the Node 24 major, found node:${tag}`;
const argError = (file, value) => `${file}: Node build argument must be 24, found ${value}`;

const cases = [
  ["Dockerfile accepts node:24-alpine", "Dockerfile", "FROM node:24-alpine\n", []],
  ["Dockerfile accepts node:24-bookworm", "Dockerfile", "FROM node:24-bookworm\n", []],
  ["suffixed Dockerfile accepts alpine", "nested/Dockerfile.build", "FROM node:24-alpine\n", []],
  ["suffixed Dockerfile accepts bookworm", "nested/Dockerfile.build", "FROM node:24-bookworm\n", []],
  ...["22", "24", "24.11.0-alpine"].flatMap((tag) => ["Dockerfile", "nested/Dockerfile.build"].map((file) => [
    `${file} rejects node:${tag}`, file, `FROM node:${tag}\n`, [imageError(file, tag)],
  ])),
  ["leading whitespace accepts valid image", "nested/Dockerfile.dev", "  FROM node:24-alpine AS base\n", []],
  ["leading whitespace rejects invalid image", "nested/Dockerfile.dev", "  FROM node:22-alpine AS base\n", [imageError("nested/Dockerfile.dev", "22-alpine")]],
  ["non-node image is ignored", "Dockerfile", "FROM alpine:22\n", []],
  ["unrelated basename is ignored", "nested/not-Dockerfile", "FROM node:22\nARG NODE_MAJOR=22\n", []],
  ...["MAJOR", "VERSION"].flatMap((arg) => ["24", "22", "24.1"].map((value) => [
    `ARG NODE_${arg}=${value}`, "nested/Dockerfile.args", `ARG NODE_${arg}=${value}\n`, value === "24" ? [] : [argError("nested/Dockerfile.args", value)],
  ])),
  ["leading whitespace accepts argument", "Dockerfile", "  ARG NODE_MAJOR=24\n", []],
  ["leading whitespace rejects argument", "Dockerfile", "  ARG NODE_VERSION=22\n", [argError("Dockerfile", "22")]],
  ["multiple failures are all reported", "nested/Dockerfile.multi", "FROM node:22\nFROM node:24\nARG NODE_MAJOR=22\nARG NODE_VERSION=24.1\n", [imageError("nested/Dockerfile.multi", "22"), imageError("nested/Dockerfile.multi", "24"), argError("nested/Dockerfile.multi", "22"), argError("nested/Dockerfile.multi", "24.1")]],
];

for (const [name, file, content, failures] of cases) {
  test(name, () => fixture((root) => {
    write(root, file, content);
    checkResult(run(root), failures);
  }));
}
