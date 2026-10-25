import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const contractDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/myrmidon/adm-connector-contract",
);
const schema = JSON.parse(
  await readFile(path.join(contractDir, "schema-v1.json"), "utf8"),
);
const examples = JSON.parse(
  await readFile(path.join(contractDir, "examples.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("ADM knowledge schema contract", () => {
  it("accepts all valid examples", () => {
    expect(examples).toHaveLength(3);
    for (const example of examples) {
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each([
    ["unknown metadata", (item: Record<string, unknown>) => { item.extra = true; }],
    ["unknown trigger", (item: Record<string, unknown>) => { item.triggers = ["made-up"]; }],
    ["non-owner rule approval", (item: Record<string, unknown>) => { item.approver_kind = "agent"; }],
    ["wrong namespace", (item: Record<string, unknown>) => { item.slug = "adm/skills/not-a-rule"; }],
    ["oversized summary", (item: Record<string, unknown>) => { item.summary = "x".repeat(301); }],
  ])("rejects %s", (_label, mutate) => {
    const invalid = structuredClone(examples[0]) as Record<string, unknown>;
    mutate(invalid);
    expect(validate(invalid)).toBe(false);
  });
});
