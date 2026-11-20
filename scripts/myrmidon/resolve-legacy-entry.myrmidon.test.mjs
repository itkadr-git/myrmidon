import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { matchExportsTarget, resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

test("legacy root and subpath selections are independent", () => {
  const cases = Object.freeze([
    Object.freeze([undefined, "index.js"]),
    Object.freeze(["dist/entry", "dist/entry.js"]),
    Object.freeze(["dist/entry.js", "dist/entry.js"]),
    Object.freeze(["dist/entry.mjs", "dist/entry.mjs"]),
    Object.freeze(["dist/entry.cjs", "dist/entry.cjs"]),
    Object.freeze(["dist/entry.ts", "dist/entry.ts"]),
    Object.freeze(["dist/entry.d.ts", "dist/entry.d.ts"]),
  ]);
  for (const exportsField of [undefined, null]) {
    for (const [main, expected] of cases) {
      assert.equal(matchExportsTarget(exportsField, main, "."), expected);
      assert.equal(matchExportsTarget(exportsField, main, "./lib/feature.js"), "lib/feature.js");
      assert.equal(matchExportsTarget(exportsField, main, "."), expected);
      assert.equal(matchExportsTarget(exportsField, main, "./missing"), "missing");
    }
  }
});

test("legacy filesystem resolution follows existing JS and reports missing targets", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, ".cache", "myrmidon-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "legacy-entry-"));
  try {
    const pkgDir = path.join(dir, "node_modules", "@myrmidon", "legacy");
    fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
    const realPkgDir = fs.realpathSync(pkgDir);
    fs.writeFileSync(path.join(pkgDir, "index.js"), "export default 1;\n");
    fs.writeFileSync(path.join(pkgDir, "lib", "feature.js"), "export default 2;\n");
    for (const manifest of [
      Object.freeze({ name: "@myrmidon/legacy" }),
      Object.freeze({ name: "@myrmidon/legacy", exports: null, main: "index" }),
      Object.freeze({ name: "@myrmidon/legacy", main: "missing" }),
    ]) {
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest));
      const root = resolveMyrmidonSpecifier("@myrmidon/legacy", dir);
      if (manifest.main === "missing") {
        assert.deepEqual(root, { failure: "файл не собран", packageName: "@myrmidon/legacy" });
      } else {
        assert.deepEqual(root, { pkgDir: realPkgDir, packageName: "@myrmidon/legacy", follow: fs.realpathSync(path.join(pkgDir, "index.js")) });
      }
      assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/legacy/lib/feature.js", dir), {
        pkgDir: realPkgDir, packageName: "@myrmidon/legacy", follow: fs.realpathSync(path.join(pkgDir, "lib", "feature.js")),
      });
      assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/legacy/lib/missing.js", dir), {
        failure: "файл не собран", packageName: "@myrmidon/legacy",
      });
      assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/legacy", dir), root);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
