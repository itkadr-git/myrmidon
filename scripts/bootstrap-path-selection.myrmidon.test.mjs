import assert from "node:assert/strict";
import test from "node:test";

import { collectReleasePackagesForChangedPaths } from "./check-release-package-bootstrap.mjs";

function freezeRecords(records) {
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

const packages = freezeRecords([
  { dir: "packages/alpha", name: "@synthetic/alpha", publishFromCi: true },
  { dir: "packages/beta", name: "@synthetic/beta", publishFromCi: true },
  { dir: "packages/disabled", name: "@synthetic/disabled", publishFromCi: false },
  { dir: "packages/duplicate", name: "@synthetic/alpha", publishFromCi: true },
]);

for (const [description, paths, expected] of [
  ["POSIX package manifest", ["packages/alpha/package.json"], [packages[0]]],
  ["Windows package manifest", ["packages\\beta\\package.json"], [packages[1]]],
  ["nearby directory prefix", ["packages/alpha-extra/package.json"], []],
  ["non-manifest path", ["packages/alpha/src/index.js"], []],
  ["off-train package", ["packages/disabled/package.json"], []],
  ["duplicate names", ["packages/alpha/package.json", "packages/duplicate/package.json"], [packages[0]]],
]) {
  test(description, () => {
    assert.deepEqual(collectReleasePackagesForChangedPaths(Object.freeze(paths), packages), expected);
  });
}

test("changed manifest selects renamed and re-enabled packages, not unchanged packages", () => {
  const current = freezeRecords([
    { dir: "packages/renamed", name: "@synthetic/new", publishFromCi: true },
    { dir: "packages/enabled", name: "@synthetic/enabled", publishFromCi: true },
    { dir: "packages/unchanged", name: "@synthetic/unchanged", publishFromCi: true },
    { dir: "packages/off", name: "@synthetic/off", publishFromCi: false },
  ]);
  const base = Object.freeze({
    source: "manifest",
    byDir: new Map([
      ["packages/renamed", Object.freeze({ name: "@synthetic/old", publishFromCi: true })],
      ["packages/enabled", Object.freeze({ name: "@synthetic/enabled", publishFromCi: false })],
      ["packages/unchanged", Object.freeze({ name: "@synthetic/unchanged", publishFromCi: true })],
      ["packages/off", Object.freeze({ name: "@synthetic/off", publishFromCi: true })],
    ]),
  });
  const changed = Object.freeze(["scripts\\release-package-manifest.json"]);
  assert.deepEqual(collectReleasePackagesForChangedPaths(changed, current, base), [current[0], current[1]]);
  assert.deepEqual(collectReleasePackagesForChangedPaths(Object.freeze(["README.md"]), current, base), []);
});
