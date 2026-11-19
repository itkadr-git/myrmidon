import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalName, extractEnvNames } from "../../check-env-registry.mjs";

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "env-static-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, "server/src", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

function one(t, source, name, variants = [name]) {
  const root = fixture(t, { "source.ts": source });
  const result = extractEnvNames(root);
  assert.deepEqual([...result.keys()], [name]);
  assert.deepEqual(result.get(name), {
    variants: new Set(variants),
    first: { file: "server/src/source.ts", line: 1 },
  });
}

test("dot access extracts a foreign name", (t) => one(t, "process.env.FOREIGN_SAMPLE", "FOREIGN_SAMPLE"));
test("single quoted bracket access", (t) => one(t, "process.env['FOREIGN_SINGLE']", "FOREIGN_SINGLE"));
test("double quoted bracket access", (t) => one(t, 'process.env["FOREIGN_DOUBLE"]', "FOREIGN_DOUBLE"));
test("backtick bracket access", (t) => one(t, 'process.env[`FOREIGN_TICK`]', "FOREIGN_TICK"));
test("bracket access accepts whitespace", (t) => one(t, "process.env[  'FOREIGN_SPACE'  ]", "FOREIGN_SPACE"));
test("readProductEnv yields the Myrmidon form", (t) => one(t, 'readProductEnv("SYNTHETIC_ALPHA")', "MYRMIDON_SYNTHETIC_ALPHA"));
test("readProductEnv combines with legacy alias", (t) => one(t, 'readProductEnv("SYNTHETIC_BETA"); process.env.PAPERCLIP_SYNTHETIC_BETA', "MYRMIDON_SYNTHETIC_BETA", ["PAPERCLIP_SYNTHETIC_BETA", "MYRMIDON_SYNTHETIC_BETA"]));
test("Myrmidon string literal is extracted", (t) => one(t, '"MYRMIDON_SYNTHETIC_LITERAL"', "MYRMIDON_SYNTHETIC_LITERAL"));
test("Paperclip string literal is canonicalized", (t) => one(t, "'PAPERCLIP_SYNTHETIC_LITERAL'", "MYRMIDON_SYNTHETIC_LITERAL", ["PAPERCLIP_SYNTHETIC_LITERAL"]));
test("canonicalName collapses both product aliases", () => {
  assert.equal(canonicalName("PAPERCLIP_SAMPLE"), "MYRMIDON_SAMPLE");
  assert.equal(canonicalName("MYRMIDON_SAMPLE"), "MYRMIDON_SAMPLE");
});
test("canonicalName preserves foreign prefixes and case", () => {
  assert.equal(canonicalName("OTHER_Mixed"), "OTHER_Mixed");
  assert.equal(canonicalName("paperclip_SAMPLE"), "paperclip_SAMPLE");
  assert.equal(canonicalName("PAPERCLIP_Mixed"), "MYRMIDON_Mixed");
});
test("variants retain only observed forms and deduplicate", (t) => {
  const root = fixture(t, { "source.ts": 'process.env.MYRMIDON_DEDUP; process.env.PAPERCLIP_DEDUP; process.env.MYRMIDON_DEDUP' });
  const result = extractEnvNames(root);
  assert.equal(result.size, 1);
  assert.deepEqual(result.get("MYRMIDON_DEDUP").variants, new Set(["MYRMIDON_DEDUP", "PAPERCLIP_DEDUP"]));
  assert.equal(result.has("PAPERCLIP_DEDUP"), false);
});
test("first location follows sorted traversal and first line", (t) => {
  const root = fixture(t, {
    "z.ts": 'process.env.MYRMIDON_ORDER',
    "a.ts": '\nprocess.env.PAPERCLIP_ORDER\nprocess.env.MYRMIDON_ORDER',
  });
  assert.deepEqual(extractEnvNames(root).get("MYRMIDON_ORDER"), {
    variants: new Set(["PAPERCLIP_ORDER", "MYRMIDON_ORDER"]),
    first: { file: "server/src/a.ts", line: 2 },
  });
});
test("multiple matches on one line are all retained", (t) => {
  const root = fixture(t, { "source.ts": 'process.env.FOREIGN_ONE; process.env.FOREIGN_TWO; process.env["FOREIGN_THREE"]' });
  assert.deepEqual([...extractEnvNames(root).keys()], ["FOREIGN_ONE", "FOREIGN_TWO", "FOREIGN_THREE"]);
});
test("sequential extraction calls do not leak regex state", (t) => {
  const root = fixture(t, { "source.ts": 'process.env.FOREIGN_FIRST; process.env.FOREIGN_SECOND\nprocess.env.FOREIGN_THIRD' });
  const expected = ["FOREIGN_FIRST", "FOREIGN_SECOND", "FOREIGN_THIRD"];
  assert.deepEqual([...extractEnvNames(root).keys()], expected);
  assert.deepEqual([...extractEnvNames(root).keys()], expected);
});
test("unrelated literals and lowercase access are not extracted", (t) => {
  const root = fixture(t, { "source.ts": '"OTHER_LITERAL"; process.env.lowercase; "MYRMIDON_GOOD"' });
  assert.deepEqual([...extractEnvNames(root).keys()], ["MYRMIDON_GOOD"]);
});
