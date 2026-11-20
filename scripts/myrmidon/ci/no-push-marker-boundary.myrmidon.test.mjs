import assert from "node:assert/strict";
import test from "node:test";
import { ALLOW_MARKER, findGitPushOffenses } from "../../check-no-git-push.mjs";

const marker = `// ${ALLOW_MARKER}`;
const first = 'await exec("git push origin main");';
const second = 'await exec("git push origin release");';

const cases = [
  { name: "unmarked command is rejected", lines: [first], expected: [{ lineNumber: 1, line: first }] },
  { name: "same-line marker allows command", lines: [`${first} ${marker}`], expected: [] },
  { name: "immediately preceding marker allows command", lines: [marker, first], expected: [] },
  { name: "marker two lines above does not allow command", lines: [marker, "const unrelated = 1;", first], expected: [{ lineNumber: 3, line: first }] },
  { name: "blank line breaks marker scope", lines: [marker, "", first], expected: [{ lineNumber: 3, line: first }] },
  { name: "marker below does not allow command", lines: [first, marker], expected: [{ lineNumber: 1, line: first }] },
  { name: "marker elsewhere does not allow command", lines: [first, "const unrelated = 1;", marker], expected: [{ lineNumber: 1, line: first }] },
  { name: "one preceding marker allows only first consecutive command", lines: [marker, first, second], expected: [{ lineNumber: 3, line: second }] },
  { name: "marker alone at beginning has no offenses", lines: [marker], expected: [] },
  { name: "independent markers allow independent commands", lines: [marker, first, "const unrelated = 1;", `${second} ${marker}`], expected: [] },
  { name: "independent markers do not allow an intervening command", lines: [marker, first, second, marker, first], expected: [{ lineNumber: 3, line: second }] },
  { name: "multiple unmarked commands report exact lines", lines: [first, "const unrelated = 1;", second], expected: [{ lineNumber: 1, line: first }, { lineNumber: 3, line: second }] },
];

for (const { name, lines, expected } of cases) {
  for (const [ending, separator] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    test(`${name} (${ending})`, () => {
      assert.deepEqual(findGitPushOffenses(lines.join(separator)), expected);
    });
  }
}
