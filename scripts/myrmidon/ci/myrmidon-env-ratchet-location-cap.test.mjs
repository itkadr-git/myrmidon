import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNames, findNewNames, parseBaseline } from "./paperclip-names-ratchet.mjs";

const name = (suffix) => ["PAPER", "CLIP_", suffix].join("");

test("baseline strips comments, blanks and duplicate names", () => {
  const known = name("KNOWN");
  const other = name("OTHER");
  assert.deepEqual([...parseBaseline(` # header\r\n${known} # inline\r\n\r\n${known}\n ${other} \n# end`)], [known, other]);
  assert.deepEqual([...parseBaseline(" # only comment\n \r\n")], []);
});

test("extracts repeated names with exact one-based lines across CRLF and blank lines", () => {
  const alpha = name("ALPHA");
  const zeta = name("ZETA");
  assert.deepEqual(extractNames(`\r\n${zeta} ${zeta}\r\n\r\n${alpha}\n${zeta}`), [
    { name: zeta, line: 2 },
    { name: zeta, line: 2 },
    { name: alpha, line: 4 },
    { name: zeta, line: 5 },
  ]);
  assert.deepEqual(extractNames("plain text\r\n\n"), []);
});

test("caps locations independently in traversal order, sorts names and excludes baseline without mutation", () => {
  const alpha = name("ALPHA");
  const zeta = name("ZETA");
  const known = name("KNOWN");
  const baseline = parseBaseline(`${known} # accepted\n${known}\n`);
  const files = [
    { path: "z.ts", text: `${zeta} ${zeta} ${alpha} ${known}\r\n\r\n${zeta} ${alpha}\r\n${zeta} ${alpha}` },
    { path: "a.ts", text: `${zeta} ${alpha} ${known}\n${zeta} ${alpha}\n${zeta} ${alpha}\n${zeta} ${alpha}` },
  ];
  const beforeFiles = structuredClone(files);
  const beforeBaseline = new Set(baseline);
  assert.deepEqual(findNewNames(files, baseline), [
    { name: alpha, places: ["z.ts:1", "z.ts:3", "z.ts:4", "a.ts:1", "a.ts:2"] },
    { name: zeta, places: ["z.ts:1", "z.ts:1", "z.ts:3", "z.ts:4", "a.ts:1"] },
  ]);
  assert.deepEqual(files, beforeFiles);
  assert.deepEqual(baseline, beforeBaseline);
  assert.deepEqual(findNewNames([{ path: "known.ts", text: `${known}\n${known}` }], baseline), []);
});
