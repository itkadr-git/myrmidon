import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(await readFile(path.join(here, "schema-v1.json"), "utf8"));
const examples = JSON.parse(await readFile(path.join(here, "examples.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

assert.equal(examples.length, 3);
for (const example of examples) {
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
}

for (const [label, mutate] of [
  ["unknown metadata", (item) => { item.extra = true; }],
  ["unknown trigger", (item) => { item.triggers = ["made-up"]; }],
  ["non-owner rule approval", (item) => { item.approver_kind = "agent"; }],
  ["wrong namespace", (item) => { item.slug = "adm/skills/not-a-rule"; }],
  ["oversized summary", (item) => { item.summary = "x".repeat(301); }],
]) {
  const invalid = structuredClone(examples[0]);
  mutate(invalid);
  assert.equal(validate(invalid), false, `Expected rejection: ${label}`);
}

console.log("ADM knowledge schema contract: 3 valid examples and 5 invalid cases verified.");
