import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractEnvNames } from "../../check-env-registry.mjs";

function fixture(t) {
  const base = path.join(os.homedir(), "cache", "scratch");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "env-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, file, name) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `process.env.${name};\n`);
}

function expected(name, file) {
  return { variants: new Set([name]), first: { file, line: 1 } };
}

for (const [label, file] of [
  ["server root", "server/src/entry.ts"],
  ["cli root", "cli/src/entry.ts"],
  ["packages root", "packages/example/src/entry.ts"],
  ["TypeScript", "server/src/file.ts"],
  ["TSX", "server/src/file.tsx"],
  ["JavaScript", "server/src/file.js"],
  ["ES module", "server/src/file.mjs"],
  ["CommonJS", "server/src/file.cjs"],
]) {
  test(`includes ${label}`, (t) => {
    const root = fixture(t);
    const name = "MYRMIDON_FIXTURE_INCLUDED";
    put(root, file, name);
    assert.deepEqual(extractEnvNames(root), new Map([[name, expected(name, file)]]));
  });
}

for (const [label, file] of [
  ["declaration", "server/src/ignored.d.ts"],
  ["test TypeScript", "server/src/ignored.test.ts"],
  ["test JavaScript", "server/src/ignored.test.js"],
  ["test module", "server/src/ignored.test.mjs"],
  ["spec TypeScript", "server/src/ignored.spec.tsx"],
  ["spec CommonJS", "server/src/ignored.spec.cjs"],
  ["unsupported extension", "server/src/ignored.json"],
  ["outside roots", "server/ignored.ts"],
  ["scripts outside roots", "scripts/ignored.ts"],
]) {
  test(`excludes ${label}`, (t) => {
    const root = fixture(t);
    const keep = "MYRMIDON_FIXTURE_KEEP";
    const control = "server/src/keep.ts";
    put(root, control, keep);
    put(root, file, "MYRMIDON_FIXTURE_IGNORED");
    assert.deepEqual(extractEnvNames(root), new Map([[keep, expected(keep, control)]]));
  });
}

for (const dir of ["scripts", "devtools", "node_modules", "dist", "build", ".turbo", "coverage", "__tests__", "fixtures", "__fixtures__"]) {
  test(`excludes ${dir} only by exact directory name`, (t) => {
    const root = fixture(t);
    const keep = "MYRMIDON_FIXTURE_NEIGHBOR";
    const neighbor = `packages/${dir}-extra/keep.ts`;
    put(root, `packages/${dir}/nested/ignored.ts`, "MYRMIDON_FIXTURE_IGNORED");
    put(root, neighbor, keep);
    assert.deepEqual(extractEnvNames(root), new Map([[keep, expected(keep, neighbor)]]));
  });
}

test("missing scan roots are tolerated", (t) => {
  const root = fixture(t);
  assert.deepEqual(extractEnvNames(root), new Map());
  const name = "MYRMIDON_FIXTURE_SINGLE_ROOT";
  put(root, "cli/src/only.ts", name);
  assert.deepEqual(extractEnvNames(root), new Map([[name, expected(name, "cli/src/only.ts")]]));
});

test("first file is independent of creation order", (t) => {
  const name = "MYRMIDON_FIXTURE_ORDER";
  const files = ["server/src/a/first.ts", "server/src/z/last.ts", "cli/src/earlier.ts"];
  const forward = fixture(t);
  const reverse = fixture(t);
  for (const file of files) put(forward, file, name);
  for (const file of [...files].reverse()) put(reverse, file, name);
  const result = new Map([[name, expected(name, "server/src/a/first.ts")]]);
  assert.deepEqual(extractEnvNames(forward), result);
  assert.deepEqual(extractEnvNames(reverse), result);
});
