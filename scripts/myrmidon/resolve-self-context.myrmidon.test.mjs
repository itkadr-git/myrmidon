import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

const specifier = "@myrmidon/self-context/feature";
const packageName = "@myrmidon/self-context";

function fixture(root, directory, name, exportsField, target) {
  const pkgDir = path.join(root, directory);
  const fromDir = path.join(pkgDir, "dist", "subdir", "deep");
  fs.mkdirSync(fromDir, { recursive: true });
  const manifest = { name, type: "module" };
  if (exportsField !== undefined) manifest.exports = exportsField;
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pkgDir, "dist", target), "export const value = 1;\n");
  return { pkgDir, fromDir, target: fs.realpathSync(path.join(pkgDir, "dist", target)) };
}

function withFixtures(run) {
  const scratch = path.join(os.homedir(), ".cache", "myrmidon-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "self-context-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it("resolves an exported self subpath from deep inside a package without a self-link", () => {
  withFixtures((root) => {
    const pkg = fixture(root, "package", packageName, { "./feature": "./dist/feature.js" }, "feature.js");
    assert.deepEqual(resolveMyrmidonSpecifier(specifier, pkg.fromDir), {
      pkgDir: pkg.pkgDir, packageName, follow: pkg.target,
    });
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/self-context/missing", pkg.fromDir), {
      failure: "подпуть не экспортируется", packageName,
    });
  });
});

it("does not fall back to a package with a different name or no exports", () => {
  withFixtures((root) => {
    const wrongName = fixture(root, "wrong-name", "@myrmidon/other", { "./feature": "./dist/feature.js" }, "feature.js");
    const noExports = fixture(root, "no-exports", packageName, undefined, "feature.js");
    for (const pkg of [wrongName, noExports]) {
      assert.deepEqual(resolveMyrmidonSpecifier(specifier, pkg.fromDir), {
        failure: "пакет не найден в node_modules", packageName,
      });
    }
  });
});

it("keeps alternating self resolutions isolated between workspace directories", () => {
  withFixtures((root) => {
    const a = fixture(root, "workspace-a", packageName, { "./feature": "./dist/a.js" }, "a.js");
    const b = fixture(root, "workspace-b", packageName, { "./feature": "./dist/b.js" }, "b.js");
    for (const pkg of [a, b, a, b]) {
      assert.deepEqual(resolveMyrmidonSpecifier(specifier, pkg.fromDir), {
        pkgDir: pkg.pkgDir, packageName, follow: pkg.target,
      });
    }
  });
});
