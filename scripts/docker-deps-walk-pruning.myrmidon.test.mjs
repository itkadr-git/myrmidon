import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./check-docker-deps-stage.mjs", import.meta.url));
const manifests = ["packages/package.json", "packages/one/package.json", "packages/one/two/package.json"];
const excluded = [
  "packages/one/two/three/package.json",
  "packages/node_modules/hidden/package.json",
  "packages/one/node_modules/package.json",
  "packages/examples/package.json",
  "packages/one/examples/package.json",
  "packages/create-paperclip-plugin/package.json",
  "packages/one/create-paperclip-plugin/package.json",
];

function snapshot(root, relative = "") {
  return readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.join(relative, entry.name);
      return entry.isDirectory() ? snapshot(root, name) : [[name, readFileSync(path.join(root, name), "base64")]];
    }).sort(([a], [b]) => a.localeCompare(b));
}

function check({ files, covered = [], missing = [], workspace = ["packages/*"] }) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "deps-walk-"));
  try {
    const put = (name, content) => {
      const target = path.join(root, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    put("pnpm-workspace.yaml", `packages:\n${workspace.map((entry) => `  - '${entry}'`).join("\n")}\n`);
    put("Dockerfile", `FROM node AS deps\nCOPY pnpm-workspace.yaml ./\n${covered.map((name) => `COPY ${name} ${name}`).join("\n")}\nFROM node AS runtime\n`);
    for (const name of files) put(name, '{"name":"fixture"}\n');
    const before = snapshot(root);
    const child = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.deepEqual(snapshot(root), before, "CLI must not change fixture files");
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, missing.length ? 1 : 0, child.stderr);
    assert.equal(child.stdout, missing.length ? "" : "PASS\n");
    const lines = child.stderr.trim() ? child.stderr.trim().split("\n") : [];
    const prefix = "Dockerfile deps stage missing package manifest coverage for: ";
    const actual = lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length)).sort();
    assert.deepEqual(actual, [...missing].sort());
    assert.deepEqual(lines.filter((line) => !line.startsWith(prefix)), missing.length ? ["Dockerfile deps stage is out of sync. Update it to cover the missing files."] : []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("covered manifests at all visited depths pass with excluded trees present", () => {
  check({ files: [...manifests, ...excluded], covered: manifests });
});

for (const missing of manifests) {
  test(`missing coverage at ${missing} fails with its exact path`, () => {
    check({ files: [...manifests, ...excluded], covered: manifests.filter((name) => name !== missing), missing: [missing] });
  });
}

test("all uncovered visited manifests are reported regardless of traversal order", () => {
  check({ files: [...manifests, ...excluded], missing: manifests });
});

test("excluded trees alone need no manifest coverage", () => {
  check({ files: excluded });
});

test("an absent workspace root is skipped", () => {
  check({ files: [], workspace: ["absent/*"] });
});

test("excluded workspace roots need no coverage", () => {
  check({ files: ["examples/package.json", "create-paperclip-plugin/package.json"], workspace: ["absent/*", "examples/*", "create-paperclip-plugin/*"] });
});
