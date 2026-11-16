import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaces = [
  "cli", "packages/db", "packages/shared", "packages/adapter-utils",
  "packages/adapters/claude-local", "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway", "packages/adapters/hermes",
  "packages/adapters/opencode-local", "packages/adapters/openclaw-gateway",
];
const original = '{"name":"fixture-cli","version":"1.2.3","dependencies":{"example":"1.0.0"}}\n';

function fixture() {
  const parent = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "cli-failstop-"));
  const inputs = [];
  function put(path, bytes) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return target;
  }
  for (const name of ["generate-npm-package-json.mjs", "cli-bundled-npm-dependencies.mjs"]) {
    const target = join(root, "scripts", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, "scripts", name), target);
  }
  for (const workspace of workspaces) {
    const path = `${workspace}/package.json`;
    put(path, workspace === "cli" ? original : '{"name":"fixture"}\n');
    if (workspace !== "cli") inputs.push(path);
  }
  const embedded = "packages/db/node_modules/embedded-postgres/package.json";
  put(embedded, '{"name":"embedded-postgres","main":"dist/index.js","optionalDependencies":{"native-fixture":"2.0.0"}}\n');
  put("packages/db/node_modules/embedded-postgres/dist/index.js", "");
  inputs.push(embedded);
  put("packages/plugins/sdk/package.json", '{"name":"fixture-sdk"}\n');
  inputs.push("packages/plugins/sdk/package.json");
  return { root, inputs, put };
}

function run(root) {
  return spawnSync(process.execPath, [join(root, "scripts/generate-npm-package-json.mjs")], {
    cwd: root, encoding: "utf8",
  });
}

const failures = [
  { name: "missing workspace manifest", path: "packages/shared/package.json", change: "missing", error: /ENOENT[\s\S]*packages\/shared\/package\.json/ },
  { name: "malformed workspace manifest", path: "packages/shared/package.json", change: "malformed", error: /broken[\s\S]*SyntaxError/ },
  { name: "missing embedded-postgres", path: "packages/db/node_modules/embedded-postgres/package.json", change: "missing-package", error: /embedded-postgres/ },
  { name: "malformed CLI dev manifest", path: "cli/package.dev.json", change: "malformed", error: /broken[\s\S]*SyntaxError/ },
];

for (const scenario of failures) {
  test(`generator preserves manifests on ${scenario.name}`, () => {
    const f = fixture();
    try {
      if (scenario.change === "missing-package") {
        rmSync(join(f.root, "packages/db/node_modules/embedded-postgres"), { recursive: true });
        f.inputs = f.inputs.filter((path) => path !== scenario.path);
      } else if (scenario.change === "missing") {
        rmSync(join(f.root, scenario.path));
        f.inputs = f.inputs.filter((path) => path !== scenario.path);
      } else {
        f.put(scenario.path, '{"broken": }\n');
        if (!f.inputs.includes(scenario.path)) f.inputs.push(scenario.path);
      }
      const before = new Map(["cli/package.json", ...f.inputs].map((path) => [path, readFileSync(join(f.root, path))]));
      const result = run(f.root);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, scenario.error);
      assert.doesNotMatch(result.stdout, /Generated publishable package\.json/);
      for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(f.root, path)), bytes, path);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("valid fixture generates the expected publish manifest", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.root, "cli/package.json"));
    const inputs = new Map(f.inputs.map((path) => [path, readFileSync(join(f.root, path))]));
    const result = run(f.root);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Generated publishable package\.json/);
    const output = readFileSync(join(f.root, "cli/package.json"));
    assert.notDeepEqual(output, before);
    assert.deepEqual(JSON.parse(output), {
      name: "fixture-cli", version: "1.2.3", engines: { node: ">=24.11.0" },
      dependencies: { example: "1.0.0" }, optionalDependencies: { "native-fixture": "2.0.0" },
    });
    for (const [path, bytes] of inputs) assert.deepEqual(readFileSync(join(f.root, path)), bytes, path);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
