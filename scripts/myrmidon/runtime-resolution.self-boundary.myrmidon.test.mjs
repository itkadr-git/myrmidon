import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

function fixture(run) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), "self-boundary-"));
  try {
    const pkg = join(root, "package");
    const write = (file, body) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    };
    const manifest = (dir, name, exports) => write(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports }));
    manifest(pkg, "@myrmidon/self", { ".": "./dist/index.js", "./feature": "./dist/feature.js" });
    write(join(pkg, "dist/index.js"), "export {};\n");
    write(join(pkg, "dist/feature.js"), "export {};\n");
    run({ root, pkg, write, manifest });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("self-reference resolves its own root and subpath exports to exact files", () => {
  fixture(({ pkg }) => {
    for (const [specifier, file] of [["@myrmidon/self", "index.js"], ["@myrmidon/self/feature", "feature.js"]]) {
      assert.deepEqual(resolveMyrmidonSpecifier(specifier, join(pkg, "dist")), {
        pkgDir: pkg, packageName: "@myrmidon/self", follow: join(pkg, "dist", file),
      });
    }
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/self/private", join(pkg, "dist")), {
      failure: "подпуть не экспортируется", packageName: "@myrmidon/self",
    });
  });
});

test("a different nearest package prevents self-reference to an ancestor", () => {
  fixture(({ pkg, manifest }) => {
    const foreign = join(pkg, "nested");
    manifest(foreign, "@myrmidon/other", { ".": "./index.js" });
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/self/feature", join(foreign, "dist")), {
      failure: "пакет не найден в node_modules", packageName: "@myrmidon/self",
    });
  });
});

test("node_modules package wins over self-reference", () => {
  fixture(({ root, pkg, write, manifest }) => {
    const installed = join(root, "node_modules/@myrmidon/self");
    manifest(installed, "@myrmidon/self", { "./feature": "./installed.js" });
    write(join(installed, "installed.js"), "export {};\n");
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/self/feature", join(pkg, "dist")), {
      pkgDir: installed, packageName: "@myrmidon/self", follow: join(installed, "installed.js"),
    });
  });
});
