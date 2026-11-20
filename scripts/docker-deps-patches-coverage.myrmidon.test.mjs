import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./check-docker-deps-stage.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");

function snapshot(dir, prefix = "") {
  return readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = path.join(prefix, entry.name);
      return entry.isDirectory() ? [[name, "directory"], ...snapshot(dir, name)] : [[name, readFileSync(path.join(dir, name)).toString("base64")]];
    });
}

function check({ patches = true, depsCopy = "", runtimeCopy = "", manifestCopy = true, success }) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "deps-coverage-"));
  try {
    const files = {
      Dockerfile: `FROM node AS deps\n${manifestCopy ? "COPY packages/demo/package.json packages/demo/package.json\n" : "RUN true\n"}${depsCopy}FROM node AS runtime\n${runtimeCopy}`,
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/demo/package.json": '{"name":"demo"}\n',
      ...(patches ? { "patches/example.patch": "synthetic patch; do not apply\n" } : {}),
    };
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const before = snapshot(root);
    const child = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.deepEqual(snapshot(root), before, "CLI must not change fixture files");
    assert.ifError(child.error);
    assert.equal(child.status, success ? 0 : 1, `stdout: ${child.stdout}\nstderr: ${child.stderr}`);
    if (success) {
      assert.equal(child.stdout, "PASS\n");
      assert.equal(child.stderr, "");
    } else {
      assert.equal(child.stdout, "");
      assert.doesNotMatch(child.stderr, /\bPASS\b/);
      assert.match(child.stderr, /Dockerfile deps stage missing: COPY patches\/ patches\//);
      assert.match(child.stderr, /Dockerfile deps stage is out of sync/);
      if (!manifestCopy) assert.match(child.stderr, /missing package manifest coverage for: packages\/demo\/package\.json/);
      else assert.doesNotMatch(child.stderr, /missing package manifest coverage/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("covered manifest passes when patches is absent", () => check({ patches: false, success: true }));
test("existing patches without COPY fails", () => check({ success: false }));
test("exact patches source in deps passes", () => check({ depsCopy: "COPY patches/ patches/\n", success: true }));
test("patches source without trailing slash fails", () => check({ depsCopy: "COPY patches patches/\n", success: false }));
test("patches destination alone does not cover source", () => check({ depsCopy: "COPY other/ patches/\n", success: false }));
test("patches source in runtime does not cover deps", () => check({ runtimeCopy: "COPY patches/ patches/\n", success: false }));
test("missing manifest and patches both appear in diagnostics", () => check({ manifestCopy: false, success: false }));
