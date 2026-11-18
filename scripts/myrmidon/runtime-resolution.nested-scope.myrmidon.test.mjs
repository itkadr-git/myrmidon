import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

function writePackage(scope, target) {
  const pkgDir = join(scope, "node_modules", "@myrmidon", "demo");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: "@myrmidon/demo",
    exports: `./dist/${target}.js`,
  }));
  writeFileSync(join(pkgDir, "dist", `${target}.js`), `export const source = "${target}";\n`);
  return { pkgDir, packageName: "@myrmidon/demo", follow: realpathSync(join(pkgDir, "dist", `${target}.js`)) };
}

test("nearest package wins independently of resolution order; missing package fails", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(process.env.HOME, ".cache", "myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "nested-resolution-"));
  try {
    const nested = join(root, "nested");
    const nestedImporter = join(nested, "app", "dist");
    const siblingImporter = join(root, "sibling", "dist");
    mkdirSync(nestedImporter, { recursive: true });
    mkdirSync(siblingImporter, { recursive: true });
    const parentResult = writePackage(root, "parent");
    const nestedResult = writePackage(nested, "nested");

    for (const [importer, expected] of [
      [nestedImporter, nestedResult],
      [siblingImporter, parentResult],
      [siblingImporter, parentResult],
      [nestedImporter, nestedResult],
    ]) {
      assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/demo", importer), expected);
    }
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/absent", nestedImporter), {
      failure: "пакет не найден в node_modules",
      packageName: "@myrmidon/absent",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
