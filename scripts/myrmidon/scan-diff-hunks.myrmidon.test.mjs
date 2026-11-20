import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileForbiddenPatterns, parseAddedLines, scan } from "./scan-diff.mjs";

describe("unified diff added-line contract", () => {
  const cases = [
    {
      name: "empty diff has no additions",
      diff: "",
      expected: [],
    },
    {
      name: "context advances the new line while deletion does not",
      diff: ["--- a/src/a.txt", "+++ b/src/a.txt", "@@ -3,3 +3,3 @@", " before", "-old", "+new", " after", "+last"].join("\n"),
      expected: [{ file: "src/a.txt", line: 4, text: "new" }, { file: "src/a.txt", line: 6, text: "last" }],
    },
    {
      name: "a later hunk resets the new line counter",
      diff: ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +2,2 @@", "+first", " context", "@@ -20 +42,2 @@", "+second", "+third"].join("\n"),
      expected: [{ file: "a.txt", line: 2, text: "first" }, { file: "a.txt", line: 42, text: "second" }, { file: "a.txt", line: 43, text: "third" }],
    },
    {
      name: "separate files keep their paths and hunk positions",
      diff: ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+alpha", "diff --git a/dir/b.txt b/dir/b.txt", "--- a/dir/b.txt", "+++ b/dir/b.txt", "@@ -8 +9 @@", "+beta"].join("\n"),
      expected: [{ file: "a.txt", line: 1, text: "alpha" }, { file: "dir/b.txt", line: 9, text: "beta" }],
    },
    {
      name: "new file uses the destination path",
      diff: ["diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"),
      expected: [{ file: "new.txt", line: 1, text: "one" }, { file: "new.txt", line: 2, text: "two" }],
    },
    {
      name: "deleted file and its removed lines have no additions",
      diff: ["diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-first", "-second"].join("\n"),
      expected: [],
    },
    {
      name: "no-newline markers do not advance the new line",
      diff: ["--- a/a.txt", "+++ b/a.txt", "@@ -2 +2,2 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file", "+next"].join("\n"),
      expected: [{ file: "a.txt", line: 2, text: "new" }, { file: "a.txt", line: 3, text: "next" }],
    },
    {
      name: "context and removed lines alone are not additions",
      diff: ["--- a/a.txt", "+++ b/a.txt", "@@ -5,2 +5 @@", " keep", "-remove"].join("\n"),
      expected: [],
    },
  ];

  for (const { name, diff, expected } of cases) {
    it(name, () => assert.deepEqual(parseAddedLines(diff), expected));
  }

  it("findings omit matched values and ignore removed values", () => {
    const value = ["fixture", "private", "marker"].join("-");
    const diff = ["--- a/config.txt", "+++ b/config.txt", "@@ -1,2 +1,2 @@", `-${value}`, " safe", `+${value}`].join("\n");
    const findings = scan(parseAddedLines(diff), {
      check: "forbidden",
      patterns: compileForbiddenPatterns(value),
    });
    assert.deepEqual(findings, [{ file: "config.txt", line: 2, rule: "forbidden pattern #1" }]);
  });
});
