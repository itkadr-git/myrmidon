import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWorkspaceGlobs } from "./prod-runtime-exports.mjs";

describe("workspace packages block boundaries", () => {
  it("reads single-quoted, double-quoted and unquoted entries across blank lines", () => {
    const yaml = [
      "packages:",
      "  - 'packages/single/*'",
      "",
      '  - "packages/double/*"',
      "  ",
      "  - packages/plain/*",
      "",
    ].join("\n");
    assert.deepEqual(parseWorkspaceGlobs(yaml), [
      "packages/single/*", "packages/double/*", "packages/plain/*",
    ]);
  });

  it("handles CRLF and stops before several unrelated top-level lists", () => {
    const yaml = [
      "packages:",
      "  - 'packages/one/*'",
      "",
      '  - "packages/two/*"',
      "catalog:",
      "  - unrelated/catalog/*",
      "overrides:",
      "  - unrelated/overrides/*",
      "",
    ].join("\r\n");
    assert.deepEqual(parseWorkspaceGlobs(yaml), ["packages/one/*", "packages/two/*"]);
  });

  it("returns no globs without a packages block, even with unrelated lists", () => {
    assert.deepEqual(parseWorkspaceGlobs("catalog:\n  - unrelated/*\noverrides:\n  - other/*\n"), []);
  });

  it("returns no globs for an empty packages block followed by unrelated lists", () => {
    assert.deepEqual(parseWorkspaceGlobs("packages:\n\ncatalog:\n  - unrelated/*\nother:\n  - ignored/*\n"), []);
  });
});
