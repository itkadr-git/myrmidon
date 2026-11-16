import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownerOf, selectTests } from "./select.mjs";

describe("ownerOf directory boundaries", () => {
  const root = { name: "root", dir: "" };
  const server = { name: "server", dir: "server" };
  const cli = { name: "cli", dir: "cli" };
  const tools = { name: "tools", dir: "cli-tools" };
  const parent = { name: "parent", dir: "packages/parent" };
  const nested = { name: "nested", dir: "packages/parent/nested" };
  const deep = { name: "deep", dir: "packages/parent/nested/deep" };
  const scoped = { name: "scoped", dir: "packages/@scope/widget" };
  const packages = [root, server, cli, tools, parent, nested, deep, scoped];

  const cases = [
    ["exact directory", "server", packages, server],
    ["file inside directory", "server/src/app.ts", packages, server],
    ["nested wins with parent first", "packages/parent/nested/src/a.ts", [parent, nested], nested],
    ["nested wins with child first", "packages/parent/nested/src/a.ts", [nested, parent], nested],
    ["server2 is not server", "server2/src/a.ts", [server], null],
    ["empty directory does not own an unknown file", "unknown/a.ts", [root], null],
    ["empty directory does not own the empty path", "", [root], null],
    ["unknown path has no owner", "other/file.ts", packages, null],
    ["cli owns its own path", "cli/src/a.ts", packages, cli],
    ["cli-tools owns its own path", "cli-tools/src/a.ts", packages, tools],
    ["cli does not own cli-tools", "cli-tools/src/a.ts", [cli], null],
    ["scoped directory owns a descendant", "packages/@scope/widget/src/a.ts", packages, scoped],
    ["scoped sibling is not owned", "packages/@scope/widget-extra/src/a.ts", [scoped], null],
    ["deepest nested package wins", "packages/parent/nested/deep/src/a.ts", packages, deep],
    ["parent owns a sibling of nested", "packages/parent/nested-other/a.ts", packages, parent],
    ["exact nested directory belongs to nested", "packages/parent/nested", packages, nested],
  ];

  for (const [name, file, candidates, expected] of cases) {
    it(name, () => assert.strictEqual(ownerOf(file, candidates), expected));
  }

  it("returns the original package object by identity", () => {
    const original = { name: "identity", dir: "identity", metadata: { marker: true } };
    assert.strictEqual(ownerOf("identity/src/index.ts", [original]), original);
  });
});

describe("selectTests nested package ownership", () => {
  it("selects the nested whole package, not the parent, in either order", () => {
    const parent = { name: "parent", dir: "packages/parent" };
    const nested = { name: "nested", dir: "packages/parent/nested" };
    const tests = [
      { file: "packages/parent/src/parent.test.ts", source: "" },
      { file: "packages/parent/nested/src/nested.test.ts", source: "" },
    ];
    for (const packages of [[parent, nested], [nested, parent]]) {
      assert.deepStrictEqual(
        selectTests(["packages/parent/nested/src/feature.ts"], packages, tests, { selective: [] }),
        { wholePackages: ["nested"], files: [] },
      );
      assert.deepStrictEqual(
        selectTests(["packages/parent/src/feature.ts"], packages, tests, { selective: [] }),
        { wholePackages: ["parent"], files: [] },
      );
    }
  });
});
