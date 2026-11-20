import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globToRegExp } from "../prod-runtime-exports.mjs";

describe("workspace glob literal contract", () => {
  const literals = [
    [".", "packages/a.b", "packages/axb"],
    ["+", "packages/a+b", "packages/aaab"],
    ["?", "packages/a?b", "packages/ab"],
    ["(", "packages/a(b", "packages/ab"],
    [")", "packages/a)b", "packages/ab"],
    ["[", "packages/a[b", "packages/ab"],
    ["]", "packages/a]b", "packages/ab"],
    ["$", "packages/a$b", "packages/ab"],
    ["^", "packages/a^b", "packages/ab"],
    ["backslash", "packages/a\\b", "packages/ab"],
  ];

  for (const [name, pattern, similar] of literals) {
    it(`matches literal ${name} and rejects a similar name`, () => {
      const regexp = globToRegExp(pattern);
      assert.equal(regexp.test(pattern), true);
      assert.equal(regexp.test(similar), false);
    });
  }

  it("keeps a single star within one segment", () => {
    const regexp = globToRegExp("packages/*/end");
    assert.equal(regexp.test("packages/name/end"), true);
    assert.equal(regexp.test("packages//end"), true);
    assert.equal(regexp.test("packages/a/b/end"), false);
  });

  it("lets a double star span multiple segments", () => {
    const regexp = globToRegExp("packages/**/end");
    assert.equal(regexp.test("packages/a/b/c/end"), true);
    assert.equal(regexp.test("packages/name/end"), true);
    assert.equal(regexp.test("packages//end"), true);
    assert.equal(regexp.test("packages/a/b/ending"), false);
  });

  it("anchors the whole path even with wildcards", () => {
    const regexp = globToRegExp("packages/*");
    assert.equal(regexp.test("packages/name"), true);
    assert.equal(regexp.test("prefix/packages/name"), false);
    assert.equal(regexp.test("packages/name/suffix"), false);
    assert.equal(globToRegExp("packages/name").test("packages/name-extra"), false);
  });
});
