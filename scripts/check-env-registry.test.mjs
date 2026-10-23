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

const REGISTRY_MD = REGISTRY_JSON.replace(/\.json$/, ".md");

function parseMatrix(mdText) {
  const sections = new Map();
  for (const part of mdText.split(/\n(?=## )/).slice(1)) {
    const [heading, ...rest] = part.split("\n");
    sections.set(heading.slice(3).trim(), rest.join("\n"));
  }
  const names = (text) => new Set([...text.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));
  const classOf = (heading) => {
    if (heading.startsWith("Продуктовые")) return "product";
    if (heading === "Секреты") return "secret";
    if (heading === "Инфраструктура") return "infra";
    return null;
  };
  const byClass = { secret: new Set(), infra: new Set(), product: new Set() };
  for (const [heading, body] of sections) {
    const cls = classOf(heading);
    if (cls) for (const name of names(body)) byClass[cls].add(name);
  }
  const patterns = new Map();
  for (const line of (sections.get("Динамические шаблоны имён") ?? "").split("\n")) {
    const m = line.match(/^\| (\S+) \| `(.+)` \| (secret|infra|product) \| /);
    if (m) patterns.set(m[1], { template: m[2], classification: m[3] });
  }
  return { byClass, patterns };
}

test("md matrix matches the JSON registry by names and classes", () => {
  const { byClass } = parseMatrix(readFileSync(REGISTRY_MD, "utf8"));
  const jsonClass = new Map(registry.entries.map((e) => [e.name, e.classification]));
  for (const cls of ["secret", "infra", "product"]) {
    for (const name of byClass[cls]) {
      assert.ok(jsonClass.has(name), `${name} is listed in md (${cls}) but absent from JSON`);
      assert.equal(jsonClass.get(name), cls, `${name}: md says ${cls}, JSON says ${jsonClass.get(name)}`);
    }
  }
  // secrets and infrastructure are listed in md in full; product has a separate UI-present part
  for (const cls of ["secret", "infra"]) {
    const expected = registry.entries.filter((e) => e.classification === cls).map((e) => e.name);
    const missing = expected.filter((name) => !byClass[cls].has(name));
    assert.deepEqual(missing, [], `${cls} names missing from md`);
  }
});

test("md dynamic patterns match JSON by id, template and class", () => {
  const { patterns } = parseMatrix(readFileSync(REGISTRY_MD, "utf8"));
  assert.deepEqual([...patterns.keys()].sort(), registry.dynamic_patterns.map((p) => p.id).sort());
  for (const p of registry.dynamic_patterns) {
    assert.deepEqual(patterns.get(p.id), { template: p.template, classification: p.classification }, p.id);
  }
});

test("oauth client id and secret are separate rules: id is infra, secret is secret", () => {
  const byId = new Map(registry.dynamic_patterns.map((p) => [p.id, p]));
  for (const family of ["tool-oauth", "cloud-oauth"]) {
    assert.equal(byId.get(`${family}-client-id`)?.classification, "infra");
    assert.equal(byId.get(`${family}-client-secret`)?.classification, "secret");
    assert.match(byId.get(`${family}-client-secret`).secret_ref_or_instance_setup, /secret-ref/);
  }
  assert.ok(!byId.has("tool-oauth-provider"));
});
