import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareBundledPackage } from "./prepare-bundled-package.mjs";

const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
mkdirSync(scratchRoot, { recursive: true });

function fixture(callback) {
  const root = mkdtempSync(join(scratchRoot, "bundle-staging-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const bin = join(root, "bin");
  const marker = join(root, "npm-called");
  mkdirSync(join(source, "lib"), { recursive: true });
  mkdirSync(destination);
  mkdirSync(bin);
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(source, "lib", "index.js"), "source marker\n");
  writeFileSync(join(destination, "sentinel"), "destination sentinel\n");
  writeFileSync(join(root, "outside"), "external sentinel\n");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    callback({ root, source, destination, marker });
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}

function manifest(source, files) {
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "fixture-package", version: "1.0.0", bundleDependencies: ["fixture-dependency"], files,
  }));
}

function assertSafeFailure(f, files, errorPattern = /path|glob|outside|contain|source/i) {
  manifest(f.source, files);
  assert.throws(() => prepareBundledPackage(f.source, f.destination, { sourceRoot: f.root }), errorPattern);
  assert.equal(readFileSync(join(f.destination, "sentinel"), "utf8"), "destination sentinel\n");
  assert.equal(readFileSync(join(f.root, "outside"), "utf8"), "external sentinel\n");
  assert.equal(existsSync(f.marker), false);
}

test("stages valid nested files in a sibling destination", () => fixture((f) => {
  manifest(f.source, ["lib/index.js"]);
  prepareBundledPackage(f.source, f.destination, { sourceRoot: f.root });
  assert.equal(readFileSync(join(f.destination, "lib/index.js"), "utf8"), "source marker\n");
  assert.equal(readFileSync(f.marker, "utf8"), "called");
}));

test("rejects unsafe package.files entries before any destructive staging", () => {
  for (const entry of ["../outside", "../../outside", "/absolute/path", "lib/*.js"]) {
    fixture((f) => assertSafeFailure(f, ["lib/index.js", entry]));
  }
});

test("rejects source entries resolving through symlinks outside source", () => fixture((f) => {
  symlinkSync(join(f.root, "outside"), join(f.source, "lib", "external"));
  assertSafeFailure(f, ["lib/external"]);
}));

test("rejects an external symlink nested in a copied directory", () => fixture((f) => {
  symlinkSync(join(f.root, "outside"), join(f.source, "lib", "external"));
  assertSafeFailure(f, ["lib"]);
}));

test("rejects overlap through a symlinked destination ancestor", () => fixture((f) => {
  manifest(f.source, []);
  symlinkSync(f.source, join(f.root, "alias"));
  assert.throws(() => prepareBundledPackage(f.source, join(f.root, "alias", "new"), { sourceRoot: f.root }), /overlap/i);
  assert.equal(readFileSync(join(f.destination, "sentinel"), "utf8"), "destination sentinel\n");
  assert.equal(readFileSync(join(f.root, "outside"), "utf8"), "external sentinel\n");
  assert.equal(existsSync(f.marker), false);
}));

test("rejects overlapping source and destination", () => {
  for (const mode of ["equal", "destination-inside-source", "source-inside-destination"]) {
    fixture((f) => {
      let source = f.source;
      let destination = f.destination;
      if (mode === "equal") destination = source;
      if (mode === "destination-inside-source") destination = join(source, "staged");
      if (mode === "source-inside-destination") source = join(destination, "staged");
      mkdirSync(source, { recursive: true });
      mkdirSync(destination, { recursive: true });
      manifest(source, []);
      writeFileSync(join(destination, "sentinel"), "destination sentinel\n");
      assert.throws(() => prepareBundledPackage(source, destination, { sourceRoot: f.root }), /overlap|contain|source|destination/i);
      assert.equal(readFileSync(join(destination, "sentinel"), "utf8"), "destination sentinel\n");
      assert.equal(readFileSync(join(f.root, "outside"), "utf8"), "external sentinel\n");
      assert.equal(existsSync(f.marker), false);
    });
  }
});
