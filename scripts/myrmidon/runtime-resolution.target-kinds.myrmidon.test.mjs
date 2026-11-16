import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { collectFailures, resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

function withFixture(target, setup, check) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || path.join(process.env.HOME, ".cache", "myrmidon-test-tmp");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "resolution-target-"));
  try {
    const pkgDir = path.join(root, "node_modules", "@myrmidon", "target");
    const dist = path.join(root, "server", "dist");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@myrmidon/target", exports: target }));
    fs.writeFileSync(path.join(dist, "index.js"), 'import "@myrmidon/target";\n');
    const write = (name, content) => {
      const file = path.join(pkgDir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    write("dist/compiled.js", "export const compiled = true;\n");
    setup({ pkgDir, write });
    check({ pkgDir, dist });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, target, setup, reason] of [
  ["missing target", "./dist/missing.js", () => {}, "файл не собран"],
  ["directory target", "./dist/directory", ({ pkgDir }) => fs.mkdirSync(path.join(pkgDir, "dist", "directory")), "цель exports не файл"],
  ["TypeScript target", "./dist/index.ts", ({ write }) => write("dist/index.ts", "export {};"), "exports указывает на .ts"],
  ["src segment target", "./src/index.js", ({ write }) => write("src/index.js", "export {};"), "exports указывает в src/"],
]) {
  it(`rejects ${name} even when another compiled JS file exists`, () => {
    withFixture(target, setup, ({ dist }) => {
      assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/target", dist), {
        failure: reason,
        packageName: "@myrmidon/target",
      });
      assert.deepEqual(collectFailures(dist), [{
        file: path.join(dist, "index.js"),
        line: 1,
        specifier: "@myrmidon/target",
        reason,
        packageName: "@myrmidon/target",
      }]);
    });
  });
}

it("follows compiled JS under src-like, not a src path segment", () => {
  withFixture("./src-like/dist.js", ({ write }) => {
    write("src-like/dist.js", 'import "@myrmidon/missing";\n');
  }, ({ pkgDir, dist }) => {
    const target = path.join(pkgDir, "src-like", "dist.js");
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/target", dist), {
      pkgDir, packageName: "@myrmidon/target", follow: fs.realpathSync(target),
    });
    assert.deepEqual(collectFailures(dist), [{
      file: target,
      line: 1,
      specifier: "@myrmidon/missing",
      reason: "пакет не найден в node_modules",
      packageName: "@myrmidon/missing",
    }]);
  });
});

it("documents the literal .d.ts target exception: no existence check or follow", () => {
  withFixture("./src/missing.d.ts", () => {}, ({ pkgDir, dist }) => {
    assert.deepEqual(resolveMyrmidonSpecifier("@myrmidon/target", dist), {
      pkgDir, packageName: "@myrmidon/target", follow: null,
    });
    assert.deepEqual(collectFailures(dist), []);
  });
});
