import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractChangelogSection } from "./release-body.mjs";

describe("changelog section boundaries", () => {
  const cases = [
    { name: "missing version", input: "## 1.7.01\nwrong version\n", version: "1.7.0", expected: null },
    { name: "empty section", input: "## 1.7.0\n  \n## 1.7.01\nneighbor\n", version: "1.7.0", expected: null },
    { name: "exact version before similar version", input: "## 1.7.0\ncorrect\n## 1.7.01\nneighbor\n", version: "1.7.0", expected: "correct" },
    { name: "exact version after similar version", input: "## 1.7.01\nneighbor\n## 1.7.0\ncorrect\n", version: "1.7.0", expected: "correct" },
    { name: "nested heading and markdown", input: "## 1.7.0\n\n### Changes\n\n- **bold** [link](https://example.test)\n  - `code`\n\n## 1.6.0\nneighbor\n", version: "1.7.0", expected: "### Changes\n\n- **bold** [link](https://example.test)\n  - `code`" },
    { name: "spaces around target heading", input: "  ## 1.7.0  \n\ncorrect\n## 1.7.01\nneighbor\n", version: "1.7.0", expected: "correct" },
    { name: "indented neighboring heading", input: "## 1.7.0\ncorrect\n  ## 1.7.01\nneighbor\n", version: "1.7.0", expected: "correct" },
    { name: "CRLF preserves body", input: "## 1.7.0\r\n\r\nfirst\r\nsecond\r\n## 1.7.01\r\nneighbor\r\n", version: "1.7.0", expected: "first\r\nsecond" },
    { name: "last section", input: "## 1.7.01\nneighbor\n## 1.7.0\nlast\n", version: "1.7.0", expected: "last" },
  ];

  for (const indent of ["", " ", "  ", "   "]) {
    for (const separator of [" ", "\t"]) {
      for (const newline of ["\n", "\r\n"]) {
        cases.push({
          name: `heading boundary ${JSON.stringify({ indent, separator, newline })}`,
          input: ["## 1.7.0", "first  ", "  ### Nested", "second", `${indent}##${separator}1.7.01`, "neighbor", ""].join(newline),
          version: "1.7.0",
          expected: ["first  ", "  ### Nested", "second"].join(newline),
        });
      }
    }
  }
  cases.push({
    name: "four-space code indentation is not a section boundary",
    input: "## 1.7.0\nfirst\n    ## example\nlast\n   ## 1.6.0\nneighbor\n",
    version: "1.7.0",
    expected: "first\n    ## example\nlast",
  });

  for (const { name, input, version, expected } of cases) {
    it(name, () => {
      const original = input;
      const result = extractChangelogSection(input, version);
      assert.equal(result, expected);
      assert.ok(result === null || !result.includes("neighbor"));
      assert.equal(input, original);
    });
  }
});
