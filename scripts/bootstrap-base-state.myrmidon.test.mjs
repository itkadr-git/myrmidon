import assert from "node:assert/strict";
import test from "node:test";

import { getBaseReleaseState } from "./check-release-package-bootstrap.mjs";

const manifestPath = "scripts/release-package-manifest.json";
const revision = "synthetic-base";

function reader(files) {
  const calls = [];
  return {
    calls,
    read(rev, path) {
      calls.push([rev, path]);
      assert.ok(Object.hasOwn(files, path), `unexpected read: ${path}`);
      return files[path];
    },
  };
}

test("missing revision returns null without reading", () => {
  for (const missing of [null, undefined, ""]) {
    const mock = reader({});
    assert.equal(getBaseReleaseState(missing, [], mock.read), null);
    assert.deepEqual(mock.calls, []);
  }
});

test("manifest takes precedence and excludes disabled or invalid entries", () => {
  const mock = reader({
    [manifestPath]: JSON.stringify([
      { dir: "packages/a", name: "@example/base-a", publishFromCi: true },
      { dir: "packages/b", name: "@example/b", publishFromCi: false },
      { dir: "packages/c", name: "@example/c" },
      { dir: "packages/d", name: "@example/d", publishFromCi: "true" },
      { dir: 7, name: "@example/e", publishFromCi: true },
      { dir: "packages/f", name: null, publishFromCi: true },
      null,
    ]),
  });
  const result = getBaseReleaseState(revision, [{ dir: "packages/a" }], mock.read);
  assert.equal(result.source, "manifest");
  assert.deepEqual(result.byDir, new Map([
    ["packages/a", { name: "@example/base-a", publishFromCi: true }],
  ]));
  assert.deepEqual(mock.calls, [[revision, manifestPath]]);
});

test("malformed manifest JSON throws without falling back", () => {
  const mock = reader({ [manifestPath]: "{" });
  assert.throws(() => getBaseReleaseState(revision, [{ dir: "packages/a" }], mock.read), SyntaxError);
  assert.deepEqual(mock.calls, [[revision, manifestPath]]);
});

test("non-array manifest throws without falling back", () => {
  const mock = reader({ [manifestPath]: '{"packages":[]}' });
  assert.throws(
    () => getBaseReleaseState(revision, [{ dir: "packages/a" }], mock.read),
    /expected scripts\/release-package-manifest\.json at synthetic-base to contain an array/,
  );
  assert.deepEqual(mock.calls, [[revision, manifestPath]]);
});

test("missing manifest falls back only to existing public package manifests", () => {
  const mock = reader({
    [manifestPath]: null,
    "packages/a/package.json": JSON.stringify({ name: "@example/base-a", private: false }),
    "packages/b/package.json": JSON.stringify({ name: "@example/b", private: true }),
    "packages/c/package.json": null,
    "packages/d/package.json": JSON.stringify({ name: "@example/d" }),
  });
  const result = getBaseReleaseState(revision, [
    { dir: "packages/a", name: "@example/current-a" },
    { dir: "packages/b" },
    { dir: "packages/c" },
    { dir: "packages/d" },
  ], mock.read);
  assert.equal(result.source, "public-packages");
  assert.deepEqual(result.byDir, new Map([
    ["packages/a", { name: "@example/base-a", publishFromCi: true }],
    ["packages/d", { name: "@example/d", publishFromCi: true }],
  ]));
  assert.deepEqual(mock.calls, [
    [revision, manifestPath],
    [revision, "packages/a/package.json"],
    [revision, "packages/b/package.json"],
    [revision, "packages/c/package.json"],
    [revision, "packages/d/package.json"],
  ]);
});

test("malformed fallback package JSON throws", () => {
  const mock = reader({ [manifestPath]: null, "packages/a/package.json": "{" });
  assert.throws(() => getBaseReleaseState(revision, [{ dir: "packages/a" }], mock.read), SyntaxError);
  assert.deepEqual(mock.calls, [[revision, manifestPath], [revision, "packages/a/package.json"]]);
});
