import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDocument, classifyDocuments } from "./split-banks.mjs";

const source = "source";
const map = {
  byAgentIdentity: { alice: "identity-bank" },
  byAgentId: { a1: "id-bank" },
  byOperatorTag: { op1: "operator-one", op2: "operator-two" },
  byDomainTag: { d1: "domain-one", d2: "domain-two" },
};

const cases = [
  ["identity beats id and tags", { agentIdentity: "alice", agentId: "a1", tags: ["domain:d1", "op1"] }, "identity-bank", "agent_identity"],
  ["unknown identity falls back to id", { agentIdentity: "unknown", agentId: "a1" }, "id-bank", "agent_id"],
  ["identity is trimmed", { agentIdentity: "  alice  ", agentId: "a1" }, "identity-bank", "agent_identity"],
  ["id is trimmed", { agentId: "  a1  " }, "id-bank", "agent_id"],
  ["id beats tags", { agentId: "a1", tags: ["op1", "domain:d1"] }, "id-bank", "agent_id"],
  ["operator beats preceding domain", { tags: ["domain:d1", "op1"] }, "operator-one", "operator_tag"],
  ["operator beats following domain", { tags: ["op1", "domain:d1"] }, "operator-one", "operator_tag"],
  ["first operator wins", { tags: ["op2", "op1"] }, "operator-two", "operator_tag"],
  ["operator order reverses winner", { tags: ["op1", "op2"] }, "operator-one", "operator_tag"],
  ["first domain wins", { tags: ["domain:d2", "domain:d1"] }, "domain-two", "domain_tag"],
  ["domain order reverses winner", { tags: ["domain:d1", "domain:d2"] }, "domain-one", "domain_tag"],
  ["unknown tags are skipped", { tags: ["unknown", "domain:unknown", "op2", "domain:d1"] }, "operator-two", "operator_tag"],
  ["unknown domains are skipped", { tags: ["domain:unknown", "domain:d1"] }, "domain-one", "domain_tag"],
  ["empty meta stays in source", {}, source, "no_author"],
  ["missing meta stays in source", undefined, source, "no_author"],
];

for (const [name, meta, targetBank, rule] of cases) {
  test(name, () => {
    assert.deepEqual(classifyDocument({ id: name, meta }, map, source), { documentId: name, targetBank, rule });
  });
}

for (const key of ["constructor", "toString", "__proto__"]) {
  for (const [field, meta] of [
    ["identity", { agentIdentity: key }],
    ["id", { agentId: key }],
    ["operator", { tags: [key] }],
    ["domain", { tags: [`domain:${key}`] }],
  ]) {
    test(`inherited ${key} is ignored for ${field}`, () => {
      assert.deepEqual(classifyDocument({ id: key, meta }, map, source), { documentId: key, targetBank: source, rule: "no_author" });
    });
  }
  for (const [field, meta] of [
    ["byAgentIdentity", { agentIdentity: key }],
    ["byAgentId", { agentId: key }],
    ["byOperatorTag", { tags: [key] }],
    ["byDomainTag", { tags: [`domain:${key}`] }],
  ]) {
    test(`own JSON ${key} is accepted for ${field}`, () => {
      const tables = { byAgentIdentity: {}, byAgentId: {}, byOperatorTag: {}, byDomainTag: {} };
      tables[field] = JSON.parse(`{"${key}":"own-bank"}`);
      const rules = { byAgentIdentity: "agent_identity", byAgentId: "agent_id", byOperatorTag: "operator_tag", byDomainTag: "domain_tag" };
      assert.deepEqual(classifyDocument({ id: key, meta }, tables, source), { documentId: key, targetBank: "own-bank", rule: rules[field] });
    });
  }
}

test("batch keeps order and count without mutating documents or map", () => {
  const docs = [
    { id: "z", meta: { tags: ["domain:d2", "op1"] } },
    { id: "a", meta: { agentIdentity: " alice " } },
    { id: "m", meta: {} },
  ];
  const docsBefore = structuredClone(docs);
  const mapBefore = structuredClone(map);
  assert.deepEqual(classifyDocuments(docs, map, source), [
    { documentId: "z", targetBank: "operator-one", rule: "operator_tag" },
    { documentId: "a", targetBank: "identity-bank", rule: "agent_identity" },
    { documentId: "m", targetBank: source, rule: "no_author" },
  ]);
  assert.deepEqual(docs, docsBefore);
  assert.deepEqual(map, mapBefore);
});
