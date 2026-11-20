import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRegistry, extractDynamicPrefixes } from "../../check-env-registry.mjs";

function fixture(t, files) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), "cache", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "env-dynamic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function registry(prefixes = []) {
  return {
    entries: [],
    counts: { unique_names: 0, secret: 0, infra: 0, product: 0 },
    dynamic_patterns: prefixes.map((prefix) => ({
      id: "fixture", template: "fixture", prefix, classification: "product",
      scope: "instance", source: "fixture", decision: "fixture",
    })),
  };
}

function check(dynamic, prefixes = []) {
  return checkRegistry({ extracted: new Map(), registry: registry(prefixes), dynamic });
}

const location = { file: "server/src/example.ts", line: 2 };
const missing = "MYRMIDON_CLOUD_*: dynamic env name built in server/src/example.ts:2 has no dynamic_patterns entry";

test("template interpolation extracts the canonical prefix and location", (t) => {
  const root = fixture(t, { "server/src/example.ts": "// fixture\nconst x = `MYRMIDON_CLOUD_${name}`;\n" });
  assert.deepEqual([...extractDynamicPrefixes(root)], [["MYRMIDON_CLOUD_", location]]);
});

test("legacy template prefix is canonicalized", (t) => {
  const root = fixture(t, { "server/src/example.ts": "// fixture\nconst x = `PAPERCLIP_CLOUD_${name}`;\n" });
  assert.deepEqual([...extractDynamicPrefixes(root)], [["MYRMIDON_CLOUD_", location]]);
});

test("quoted trailing underscore is a dynamic prefix", (t) => {
  const root = fixture(t, { "server/src/example.ts": "// fixture\nconst x = 'MYRMIDON_CLOUD_';\n" });
  assert.deepEqual([...extractDynamicPrefixes(root)], [["MYRMIDON_CLOUD_", location]]);
});

test("legacy quoted prefix is canonicalized", (t) => {
  const root = fixture(t, { "server/src/example.ts": "// fixture\nconst x = \"PAPERCLIP_CLOUD_\";\n" });
  assert.deepEqual([...extractDynamicPrefixes(root)], [["MYRMIDON_CLOUD_", location]]);
});

test("base prefix concatenation is detected", (t) => {
  const root = fixture(t, { "server/src/example.ts": "// fixture\nconst x = 'MYRMIDON_' + name;\n" });
  assert.deepEqual([...extractDynamicPrefixes(root)], [["MYRMIDON_", location]]);
});

test("legacy base prefix concatenation is canonicalized", (t) => {
  const root = fixture(t, { "server/src/example.ts": "// fixture\nconst x = 'PAPERCLIP_' + name;\n" });
  assert.deepEqual([...extractDynamicPrefixes(root)], [["MYRMIDON_", location]]);
});

test("the first occurrence wins across aliases and files", (t) => {
  const root = fixture(t, {
    "server/src/a.ts": "// fixture\nconst a = 'PAPERCLIP_CLOUD_';\nconst b = 'MYRMIDON_CLOUD_';\n",
    "server/src/b.ts": "const c = 'MYRMIDON_CLOUD_';\n",
  });
  assert.deepEqual([...extractDynamicPrefixes(root)], [["MYRMIDON_CLOUD_", { file: "server/src/a.ts", line: 2 }]]);
});

test("repeated scans and multiple matches do not retain regex state", (t) => {
  const root = fixture(t, { "server/src/example.ts": "const a = 'MYRMIDON_ONE_'; const b = 'MYRMIDON_TWO_';\nconst c = 'MYRMIDON_THREE_';\n" });
  const expected = [["MYRMIDON_ONE_", { file: "server/src/example.ts", line: 1 }], ["MYRMIDON_TWO_", { file: "server/src/example.ts", line: 1 }], ["MYRMIDON_THREE_", location]];
  assert.deepEqual([...extractDynamicPrefixes(root)], expected);
  assert.deepEqual([...extractDynamicPrefixes(root)], expected);
});

test("a static full name is not a dynamic prefix", (t) => {
  const root = fixture(t, { "server/src/example.ts": "const a = 'MYRMIDON_STATIC_NAME';\n" });
  assert.deepEqual([...extractDynamicPrefixes(root)], []);
});

test("an exact registered prefix covers the extracted dynamic name", (t) => {
  const root = fixture(t, { "server/src/example.ts": "// fixture\nconst a = `MYRMIDON_CLOUD_${name}`;\n" });
  assert.deepEqual(check(extractDynamicPrefixes(root), ["MYRMIDON_CLOUD_"]), []);
});

test("an uncovered prefix reports the exact diagnostic", () => {
  assert.deepEqual(check(new Map([["MYRMIDON_CLOUD_", location]])), [missing]);
});

test("a shorter similar prefix does not cover a dynamic name", () => {
  assert.deepEqual(check(new Map([["MYRMIDON_CLOUD_", location]]), ["MYRMIDON_"]), [missing]);
});

test("a longer similar prefix does not cover a dynamic name", () => {
  assert.deepEqual(check(new Map([["MYRMIDON_CLOUD_", location]]), ["MYRMIDON_CLOUD_OAUTH_"]), [missing]);
});

test("legacy registry prefix covers its canonical dynamic alias", () => {
  assert.deepEqual(check(new Map([["MYRMIDON_CLOUD_", location]]), ["PAPERCLIP_CLOUD_"]), []);
});

test("omitting dynamic input does not report missing prefixes", () => {
  assert.deepEqual(checkRegistry({ extracted: new Map(), registry: registry() }), []);
});
