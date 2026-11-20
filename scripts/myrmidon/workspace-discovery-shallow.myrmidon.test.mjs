import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { workspacePackageDirs } from "./prod-runtime-exports.mjs";

let root;

function write(relativePath, content = "{}\n") {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function workspace(...includes) {
  write("pnpm-workspace.yaml", `packages:\n${includes.map((entry) => `  - ${entry}\n`).join("")}`);
  return workspacePackageDirs(root);
}

before(() => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "workspace-shallow-"));
  write("packages/zeta/package.json");
  write("packages/alpha/package.json");
  write("packages/alpha/nested/package.json");
  write("packages/container/nested/package.json");
  write("packages/no-manifest/readme.txt", "not a package\n");
  write("packages/plain-file", "not a directory\n");
  write("standalone/package.json");
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("shallow workspace discovery", () => {
  it("includes literal package directories and ignores missing directories and manifests", () => {
    assert.deepEqual(workspace("standalone", "absent", "packages/no-manifest", "packages/plain-file"), [
      join(root, "standalone"),
    ]);
  });

  it("ignores a missing glob base", () => {
    assert.deepEqual(workspace("absent/*"), []);
  });

  it("matches only immediate package directories, not files, manifestless directories or nested packages", () => {
    assert.deepEqual(workspace("packages/*"), [
      join(root, "packages/alpha"),
      join(root, "packages/zeta"),
    ]);
  });

  it("deduplicates overlapping literal and glob includes and sorts the paths", () => {
    assert.deepEqual(workspace("standalone", "packages/zeta", "packages/*", "packages/alpha", "packages/*"), [
      join(root, "packages/alpha"),
      join(root, "packages/zeta"),
      join(root, "standalone"),
    ]);
  });
});
