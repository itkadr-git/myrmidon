import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPluginsUnder } from "../../link-plugin-dev-sdk.mjs";

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), "cache", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "sdk-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "plugins");
  mkdirSync(parent);
  const pkg = (path) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), "{}");
    return path;
  };
  const expect = (...paths) => assert.deepEqual(new Set(readPluginsUnder(parent)), new Set(paths));
  return { root, parent, pkg, expect };
}

test("does not follow a directory symlink to an outside package", (t) => {
  const { root, parent, pkg, expect } = fixture(t);
  const external = pkg(join(root, "external"));
  const sentinel = join(external, "sentinel");
  writeFileSync(sentinel, "unchanged");
  symlinkSync(external, join(parent, "linked"), "dir");
  const real = pkg(join(parent, "real"));
  expect(real);
  assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
});

test("does not traverse a symlink loop", (t) => {
  const { parent, pkg, expect } = fixture(t);
  const nested = join(parent, "nested");
  mkdirSync(nested);
  symlinkSync(parent, join(nested, "loop"), "dir");
  const real = pkg(join(nested, "real"));
  expect(real);
});

test("excludes node_modules at multiple depths", (t) => {
  const { parent, pkg, expect } = fixture(t);
  pkg(join(parent, "node_modules", "hidden"));
  pkg(join(parent, "group", "node_modules", "hidden"));
  const real = pkg(join(parent, "group", "visible"));
  expect(real);
});

test("finds real sibling packages with exact paths", (t) => {
  const { parent, pkg, expect } = fixture(t);
  const first = pkg(join(parent, "first"));
  const second = pkg(join(parent, "second"));
  mkdirSync(join(parent, "empty"));
  expect(first, second);
});

test("finds packages under deep non-package directories", (t) => {
  const { parent, pkg, expect } = fixture(t);
  const deep = pkg(join(parent, "one", "two", "three", "plugin"));
  mkdirSync(join(parent, "one", "empty"));
  expect(deep);
});

test("stops at package boundaries", (t) => {
  const { parent, pkg, expect } = fixture(t);
  const outer = pkg(join(parent, "outer"));
  pkg(join(outer, "nested"));
  const sibling = pkg(join(parent, "sibling"));
  expect(outer, sibling);
});

test("does not return the parent even when it is a package", (t) => {
  const { parent, pkg, expect } = fixture(t);
  pkg(parent);
  const child = pkg(join(parent, "child"));
  expect(child);
});

test("ignores ordinary files beside real packages", (t) => {
  const { parent, pkg, expect } = fixture(t);
  writeFileSync(join(parent, "ordinary"), "not a directory");
  writeFileSync(join(parent, "package.json"), "{}");
  const real = pkg(join(parent, "real"));
  expect(real);
});
