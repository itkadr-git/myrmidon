import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { buildPlaceholderFiles, PLACEHOLDER_VERSION } from "../../bootstrap-npm-package.mjs";

for (const packageName of ["@myrmidon/example", "@myrmidon/another-package_2"]) {
  test(`placeholder files agree for ${packageName}`, () => {
    const result = buildPlaceholderFiles(packageName);
    assert.deepEqual(Object.keys(result).sort(), ["README.md", "deprecationNote", "index.js", "package.json"]);
    assert.equal(PLACEHOLDER_VERSION, "0.0.0");
    const manifest = JSON.parse(result["package.json"]);
    assert.equal(manifest.name, packageName);
    assert.equal(manifest.version, PLACEHOLDER_VERSION);
    assert.equal(manifest.main, "index.js");
    assert.deepEqual(manifest.files, ["index.js"]);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.publishConfig.access, "public");

    const notePrefix = `${packageName}@0.0.0 is a placeholder that reserves the package name for Paperclip's release pipeline. It contains no functionality; the first real release supersedes it. See `;
    assert.equal(result.deprecationNote, `${notePrefix}${manifest.homepage}`);
    const script = new Script(result["index.js"], { filename: "index.js" });
    assert.throws(() => script.runInThisContext(), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, result.deprecationNote);
      return true;
    });
    assert.ok(result["README.md"].includes(packageName));
    assert.ok(result["README.md"].includes(PLACEHOLDER_VERSION));
  });
}

test("repeated calls are deterministic and return independent objects", () => {
  const first = buildPlaceholderFiles("@myrmidon/example");
  const second = buildPlaceholderFiles("@myrmidon/example");
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, second);
  first["package.json"] = "modified";
  first.deprecationNote = "modified";
  assert.deepEqual(second, buildPlaceholderFiles("@myrmidon/example"));
});
