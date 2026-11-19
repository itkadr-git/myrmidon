import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalName, extractEnvNames } from "../../check-env-registry.mjs";

function fixture(t, files) {
  const scratch = path.join(os.homedir(), "cache", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "env-static-"));
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
test("readProductEnv combines with legacy alias", (t) => one(t, 'readProductEnv("API_URL"); process.env.PAPERCLIP_API_URL', "MYRMIDON_API_URL", ["PAPERCLIP_API_URL", "MYRMIDON_API_URL"]));
test("Myrmidon string literal is extracted", (t) => one(t, '"MYRMIDON_AGENT_ID"', "MYRMIDON_AGENT_ID"));
test("Paperclip string literal is canonicalized", (t) => one(t, "'PAPERCLIP_AGENT_ID'", "MYRMIDON_AGENT_ID", ["PAPERCLIP_AGENT_ID"]));
test("canonicalName collapses both product aliases", () => {
  assert.equal(canonicalName("PAPERCLIP_HOME"), "MYRMIDON_HOME");
  assert.equal(canonicalName("MYRMIDON_HOME"), "MYRMIDON_HOME");
});
test("canonicalName preserves foreign prefixes and case", () => {
  assert.equal(canonicalName("OTHER_Mixed"), "OTHER_Mixed");
  assert.equal(canonicalName("paperclip_SAMPLE"), "paperclip_SAMPLE");
  assert.equal(canonicalName("PAPERCLIP_API_URLmixed"), "MYRMIDON_API_URLmixed");
});
test("variants retain only observed forms and deduplicate", (t) => {
  const root = fixture(t, { "source.ts": 'process.env.MYRMIDON_COMPANY_ID; process.env.PAPERCLIP_COMPANY_ID; process.env.MYRMIDON_COMPANY_ID' });
  const result = extractEnvNames(root);
  assert.equal(result.size, 1);
  assert.deepEqual(result.get("MYRMIDON_COMPANY_ID").variants, new Set(["MYRMIDON_COMPANY_ID", "PAPERCLIP_COMPANY_ID"]));
  assert.equal(result.has("PAPERCLIP_COMPANY_ID"), false);
});
test("first location follows sorted traversal and first line", (t) => {
  const root = fixture(t, {
    "z.ts": 'process.env.MYRMIDON_RUN_ID',
    "a.ts": '\nprocess.env.PAPERCLIP_RUN_ID\nprocess.env.MYRMIDON_RUN_ID',
  });
  assert.deepEqual(extractEnvNames(root).get("MYRMIDON_RUN_ID"), {
    variants: new Set(["PAPERCLIP_RUN_ID", "MYRMIDON_RUN_ID"]),
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
