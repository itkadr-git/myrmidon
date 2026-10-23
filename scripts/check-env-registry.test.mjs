import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalName, checkRegistry, extractDynamicPrefixes, extractEnvNames, parseCsv, REGISTRY_CSV, REGISTRY_JSON } from "./check-env-registry.mjs";

const registry = JSON.parse(readFileSync(REGISTRY_JSON, "utf8"));
const csvText = readFileSync(REGISTRY_CSV, "utf8");

test("PAPERCLIP_X and MYRMIDON_X are one variable", () => {
  assert.equal(canonicalName("PAPERCLIP_FOO"), "MYRMIDON_FOO");
  assert.equal(canonicalName("MYRMIDON_FOO"), "MYRMIDON_FOO");
  assert.equal(canonicalName("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY");
});

test("registry covers every env name used by the code", () => {
  const problems = checkRegistry({ extracted: extractEnvNames("."), registry, csvText, dynamic: extractDynamicPrefixes(".") });
  assert.deepEqual(problems, []);
});

test("a name missing from the registry is reported", () => {
  const extracted = new Map([["MYRMIDON_NOT_IN_REGISTRY_XYZ", { variants: new Set(), first: { file: "a.ts", line: 1 } }]]);
  const problems = checkRegistry({ extracted, registry });
  assert.ok(problems.some((p) => p.startsWith("MYRMIDON_NOT_IN_REGISTRY_XYZ")));
});

test("an unclassified entry is reported", () => {
  const broken = { ...registry, entries: [{ ...registry.entries[0], decision: "pending-audit" }, ...registry.entries.slice(1)] };
  const problems = checkRegistry({ extracted: new Map(), registry: broken });
  assert.ok(problems.some((p) => p.includes("decision")));
});

test("csv parser handles quotes and commas", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\n1,2,3\n'), [["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
});

test("every runtime-built env prefix has a dynamic pattern, including MYRMIDON_MCP_TOKEN_", () => {
  const dynamic = extractDynamicPrefixes(".");
  assert.ok(dynamic.has("MYRMIDON_MCP_TOKEN_"));
  assert.deepEqual(checkRegistry({ extracted: new Map(), registry, dynamic }), []);
});

test("a runtime-built prefix without a pattern is reported", () => {
  const dynamic = new Map([["MYRMIDON_UNKNOWN_FAMILY_", { file: "a.ts", line: 1 }]]);
  const problems = checkRegistry({ extracted: new Map(), registry, dynamic });
  assert.ok(problems.some((p) => p.startsWith("MYRMIDON_UNKNOWN_FAMILY_")));
});
