import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

function withPackage(target, setup, check) {
  const scratch = join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "target-class-"));
  try {
    const pkgDir = join(root, "node_modules", "@myrmidon", "fixture");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@myrmidon/fixture", exports: target }));
    setup(pkgDir);
    check(resolveMyrmidonSpecifier("@myrmidon/fixture", root), realpathSync(pkgDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeTarget(pkgDir, target) {
  const file = join(pkgDir, target);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export {};\n");
}

const nothing = () => {};

for (const [name, target, setup, failure] of [
  ["malformed package JSON", "./dist/index.js", (dir) => writeFileSync(join(dir, "package.json"), "{"), "package.json не читается"],
  ["TypeScript target", "./src/index.ts", (dir) => writeTarget(dir, "src/index.ts"), "exports указывает на .ts"],
  ["source JavaScript target", "./src/index.js", (dir) => writeTarget(dir, "src/index.js"), "exports указывает в src/"],
  ["missing dist target", "./dist/index.js", nothing, "файл не собран"],
  ["directory target", "./dist/index.js", (dir) => mkdirSync(join(dir, "dist/index.js"), { recursive: true }), "цель exports не файл"],
]) {
  it(`rejects ${name} without a follow path`, () => {
    withPackage(target, setup, (result) => {
      assert.deepEqual(result, { failure, packageName: "@myrmidon/fixture" });
      assert.equal(Object.hasOwn(result, "follow"), false);
    });
  });
}

for (const target of ["./dist/index.js", "./dist/index.mjs", "./dist/index.cjs", "./srcish/index.js"]) {
  it(`follows existing ${target}`, () => {
    withPackage(target, (dir) => writeTarget(dir, target), (result, pkgDir) => {
      assert.deepEqual(result, {
        pkgDir,
        packageName: "@myrmidon/fixture",
        follow: realpathSync(join(pkgDir, target)),
      });
    });
  });
}

it("does not follow a missing declaration target, even inside src", () => {
  withPackage("./src/index.d.ts", nothing, (result, pkgDir) => {
    assert.deepEqual(result, { pkgDir, packageName: "@myrmidon/fixture", follow: null });
  });
});
