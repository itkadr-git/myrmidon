import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { workspacePackageDirs } from "./prod-runtime-exports.mjs";

function withWorkspace(globs, packages, check) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "workspace-discovery-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n${globs.map((glob) => `  - '${glob}'`).join("\n")}\n`);
    for (const pkg of packages) {
      const dir = join(root, pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
    }
    check(workspacePackageDirs(root).map((dir) => relative(root, dir).split("\\").join("/")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("recursive includes cross directories without a manifest and stop at the nearest package", () => {
  withWorkspace(["packages/**"], [
    "packages/group/deep/member",
    "packages/parent",
    "packages/parent/child",
    "packages/node_modules/hidden",
    "packages/group/node_modules/hidden",
  ], (dirs) => {
    assert.deepEqual(dirs, ["packages/group/deep/member", "packages/parent"]);
  });
});

test("recursive exclusions remove the directory and descendants without excluding similarly named siblings", () => {
  withWorkspace(["packages/**", "!packages/excluded/**"], [
    "packages/excluded",
    "packages/excluded/nested/hidden",
    "packages/excluded-extra/member",
    "packages/ordinary",
  ], (dirs) => {
    assert.deepEqual(dirs, ["packages/excluded-extra/member", "packages/ordinary"]);
  });
  // Without a manifest at the excluded root, the recursive include discovers its descendants.
  withWorkspace(["packages/**", "!packages/excluded/**"], [
    "packages/excluded/nested/hidden",
    "packages/excluded-extra/member",
    "packages/ordinary",
  ], (dirs) => {
    assert.deepEqual(dirs, ["packages/excluded-extra/member", "packages/ordinary"]);
  });
});
