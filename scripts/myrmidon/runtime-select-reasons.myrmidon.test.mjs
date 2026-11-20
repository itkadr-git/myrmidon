import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectSubstitutions } from "./prod-runtime-exports.mjs";

const entry = "@fixture/entry";
const dependency = "@fixture/dependency";

function checkSelection(t, manifest, expectedOverrides, expectedReasons, entryManifest = {}) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".myrmidon-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "runtime-select-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = [join(root, "entry"), join(root, "dependency"), join(root, "unrelated")];
  const manifests = [
    { name: entry, ...entryManifest },
    { name: dependency, ...manifest },
    { name: "@fixture/unrelated", main: "./src/index.js" },
  ];
  const files = paths.map((dir, i) => {
    mkdirSync(dir);
    const file = join(dir, "package.json");
    writeFileSync(file, `${JSON.stringify(manifests[i], null, 2)}\n`);
    return file;
  });
  const sentinel = join(root, "untouched.txt");
  writeFileSync(sentinel, "unchanged\n");
  files.push(sentinel);
  const bytes = files.map((file) => readFileSync(file));
  const closure = new Map([[entry, paths[0]], [dependency, paths[1]]]);
  const index = new Map([...closure, ["@fixture/unrelated", paths[2]]]);
  const closureBefore = new Map(closure);
  const indexBefore = new Map(index);

  const result = selectSubstitutions(entry, closure, index);
  assert.deepStrictEqual(result, {
    overridesByPackage: new Map(expectedOverrides),
    skipReasons: new Map(expectedReasons),
  });
  assert.deepStrictEqual(closure, closureBefore);
  assert.deepStrictEqual(index, indexBefore);
  assert.deepStrictEqual(files.map((file) => readFileSync(file)), bytes);
}

const skippedEntry = [entry, "entry package"];

test("entry is skipped even when its publishConfig differs", (t) => {
  checkSelection(t, {}, [], [skippedEntry, [dependency, "no publishConfig main/types/exports"]], {
    main: "./src/index.js", publishConfig: { main: "./dist/index.js" },
  });
});

test("dependency without publishConfig is skipped", (t) => {
  checkSelection(t, { main: "./src/index.js" }, [], [skippedEntry, [dependency, "no publishConfig main/types/exports"]]);
});

test("dependency with only publishConfig bin is skipped", (t) => {
  checkSelection(t, { publishConfig: { bin: "./dist/cli.js" } }, [], [skippedEntry, [dependency, "no publishConfig main/types/exports"]]);
});

test("matching main types and exports are already serving dist", (t) => {
  const fields = { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": "./dist/index.js" } };
  checkSelection(t, { ...fields, publishConfig: fields }, [], [skippedEntry, [dependency, "already serving dist"]]);
});

test("differing main selects the package and returns all publish overrides", (t) => {
  const fields = { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": "./dist/index.js" } };
  checkSelection(t, { ...fields, main: "./src/index.js", publishConfig: fields }, [[dependency, fields]], [skippedEntry]);
});

test("differing types selects the package and returns all publish overrides", (t) => {
  const fields = { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": "./dist/index.js" } };
  checkSelection(t, { ...fields, types: "./src/index.d.ts", publishConfig: fields }, [[dependency, fields]], [skippedEntry]);
});

test("differing exports selects the package and returns all publish overrides", (t) => {
  const fields = { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": "./dist/index.js" } };
  checkSelection(t, { ...fields, exports: { ".": "./src/index.js" }, publishConfig: fields }, [[dependency, fields]], [skippedEntry]);
});

test("absent top-level main selects despite matching exports", (t) => {
  const fields = { main: "./dist/index.js", exports: { ".": "./dist/index.js" } };
  checkSelection(t, { exports: fields.exports, publishConfig: fields }, [[dependency, fields]], [skippedEntry]);
});
