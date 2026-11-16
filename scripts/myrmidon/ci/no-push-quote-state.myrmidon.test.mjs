import test from "node:test";
import assert from "node:assert/strict";
import { findGitPushOffenses } from "../../check-no-git-push.mjs";

const cases = [
  { slashes: "", detects: false },
  { slashes: "\\", detects: true },
  { slashes: "\\\\", detects: false },
  { slashes: "\\\\\\", detects: true },
  { slashes: "\\\\\\\\", detects: false },
];

for (const quote of ["'", '"', "`"]) {
  for (const { slashes, detects } of cases) {
    test(`${JSON.stringify(quote)} with ${slashes.length} backslashes before quote`, () => {
      const line = `const value = ${quote}value${slashes}${quote}; // git push origin main`;
      assert.deepEqual(findGitPushOffenses(`const before = 1;\n${line}\nconst after = 2;`),
        detects ? [{ lineNumber: 2, line }] : []);
    });
  }

  test(`${JSON.stringify(quote)} preserves URL before a command`, () => {
    const line = `const url = ${quote}https://example.test/path${quote}; git push origin main`;
    assert.deepEqual(findGitPushOffenses(`// harmless\n${line}`), [{ lineNumber: 2, line }]);
  });
}

test("ignores a standalone line comment", () => {
  assert.deepEqual(findGitPushOffenses("const before = 1;\n// git push origin main"), []);
});
