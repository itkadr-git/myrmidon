import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspacePaths = [
  "cli", "packages/db", "packages/shared", "packages/adapter-utils",
  "packages/adapters/claude-local", "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway", "packages/adapters/hermes",
  "packages/adapters/opencode-local", "packages/adapters/openclaw-gateway",
];

function writeJson(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
}

function withFixture(run) {
  const scratch = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "cli-filter-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const name of ["generate-npm-package-json.mjs", "cli-bundled-npm-dependencies.mjs"]) {
      copyFileSync(join(scriptsDir, name), join(root, "scripts", name));
    }
    for (const path of workspacePaths) writeJson(root, `${path}/package.json`, {});
    writeJson(root, "cli/package.json", { name: "fixture-cli", version: "1.0.0", dependencies: {
      acpx: "1.0.0", "@myrmidon/shared": "workspace:*", "ordinary-cli": "^1.2.3",
    } });
    writeJson(root, "packages/db/package.json", { dependencies: {
      "embedded-postgres": "2.0.0", postgres: "3.0.0", "@myrmidon/db": "workspace:*", "@scope/ordinary": "~4.5.6",
    } });
    writeJson(root, "packages/shared/package.json", { dependencies: {
      zod: "4.0.0", "@myrmidonish/keep": "5.6.7", "postgres-helper": "^8.0.0",
    } });
    writeJson(root, "packages/adapter-utils/package.json", { dependencies: {
      "@myrmidon/server": "workspace:*", "ordinary-adapter": "9.1.2",
    } });
    writeJson(root, "server/package.json", { version: "1.2.3" });
    writeJson(root, "packages/db/node_modules/embedded-postgres/package.json", { main: "dist/index.js" });
    const entry = join(root, "packages/db/node_modules/embedded-postgres/dist/index.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function generate(root) {
  const result = spawnSync(process.execPath, [join(root, "scripts/generate-npm-package-json.mjs")], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const bytes = readFileSync(join(root, "cli/package.json"));
  assert.ok(bytes.length > 0);
  return JSON.parse(bytes.toString("utf8")).dependencies;
}

function expected(version) {
  return {
    "@myrmidon/server": version,
    "@myrmidonish/keep": "5.6.7",
    "@scope/ordinary": "~4.5.6",
    "ordinary-adapter": "9.1.2",
    "ordinary-cli": "^1.2.3",
    "postgres-helper": "^8.0.0",
  };
}

test("CLI publish dependencies filter bundled and internal names and track server version", () => {
  withFixture((root) => {
    assert.deepEqual(generate(root), expected("1.2.3"));
    writeJson(root, "server/package.json", { version: "7.8.9" });
    assert.deepEqual(generate(root), expected("7.8.9"));
  });
});

test("negative control detects a bundled dependency returned by the generator", () => {
  withFixture((root) => {
    const bundled = join(root, "scripts/cli-bundled-npm-dependencies.mjs");
    const original = readFileSync(bundled, "utf8");
    const mutated = original.replace('  "postgres",\n', "");
    assert.notEqual(mutated, original);
    writeFileSync(bundled, mutated);
    assert.throws(() => assert.deepEqual(generate(root), expected("1.2.3")), {
      code: "ERR_ASSERTION",
      operator: "deepStrictEqual",
    });
  });
});
