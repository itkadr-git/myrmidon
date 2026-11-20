import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { buildPlaceholderFiles } from "../../bootstrap-npm-package.mjs";

const names = ["@myrmidon/placeholder-alpha", "@myrmidon/placeholder-beta"];

function assertPlaceholder(files, name) {
  assert.deepEqual(Object.keys(files).sort(), ["README.md", "deprecationNote", "index.js", "package.json"].sort());
  for (const value of Object.values(files)) {
    assert.equal(typeof value, "string");
    assert.notEqual(value.length, 0);
    assert.doesNotMatch(value, /workspace:/i);
  }
  const manifest = JSON.parse(files["package.json"]);
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, "0.0.0");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.main, "index.js");
  assert.deepEqual(manifest.files, ["index.js"]);
  for (const key of ["dependencies", "devDependencies", "scripts"]) {
    assert.equal(Object.hasOwn(manifest, key), false);
  }
  assert.throws(() => runInNewContext(files["index.js"], {}, { timeout: 1000 }), (error) => {
    assert.equal(error.name, "Error");
    assert.equal(error.message, files.deprecationNote);
    return true;
  });
}

test("placeholder contract holds independently for two package names", () => {
  for (const name of names) assertPlaceholder(buildPlaceholderFiles(name), name);
});

test("repeated results are deterministic and isolated from mutations", () => {
  for (const name of names) {
    const first = buildPlaceholderFiles(name);
    const expected = buildPlaceholderFiles(name);
    assert.deepEqual(first, expected);
    for (const key of Object.keys(first)) first[key] = "corrupted";
    assert.deepEqual(buildPlaceholderFiles(name), expected);
  }
  assert.notDeepEqual(buildPlaceholderFiles(names[0]), buildPlaceholderFiles(names[1]));
});

test("contract rejects invalid placeholder outputs", () => {
  const valid = buildPlaceholderFiles(names[0]);
  assert.throws(() => assertPlaceholder({}, names[0]));
  assert.throws(() => assertPlaceholder({ ...valid, "index.js": "void 0" }, names[0]));
  assert.throws(() => assertPlaceholder({ ...valid, deprecationNote: "different" }, names[0]));
  const manifest = JSON.parse(valid["package.json"]);
  manifest.dependencies = { other: "workspace:*" };
  assert.throws(() => assertPlaceholder({ ...valid, "package.json": JSON.stringify(manifest) }, names[0]));
});
