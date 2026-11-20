import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildPackageIndex } from "./prod-runtime-exports.mjs";

test("indexes only named workspace members and picks the first sorted duplicate", () => {
  const scratch = resolve(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test-scratch"));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "workspace-package-index-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - 'later/*'\n  - '!packages/excluded'\n");
    const addPackage = (dir, manifest) => {
      const absolute = join(root, dir);
      mkdirSync(absolute, { recursive: true });
      writeFileSync(join(absolute, "package.json"), JSON.stringify(manifest));
    };

    addPackage("packages/a-duplicate", { name: "duplicate" });
    addPackage("later/z-duplicate", { name: "duplicate" });
    addPackage("packages/scoped", { name: "@scope/exact-name" });
    addPackage("packages/plain", { name: "plain-name" });
    addPackage("packages/excluded", { name: "excluded-name" });
    addPackage("outside/hidden", { name: "outside-name" });
    addPackage("packages/absent", { version: "1.0.0" });
    addPackage("packages/empty", { name: "" });
    addPackage("packages/number", { name: 42 });
    addPackage("packages/null", { name: null });
    addPackage("packages/object", { name: { value: "invalid" } });

    assert.deepStrictEqual(buildPackageIndex(root), new Map([
      ["duplicate", join(root, "later/z-duplicate")],
      ["plain-name", join(root, "packages/plain")],
      ["@scope/exact-name", join(root, "packages/scoped")],
    ]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
