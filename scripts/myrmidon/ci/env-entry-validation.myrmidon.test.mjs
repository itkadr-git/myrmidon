import assert from "node:assert/strict";
import test from "node:test";
import { checkRegistry } from "../../check-env-registry.mjs";

const entry = {
  name: "MYRMIDON_EXAMPLE", classification: "infra", scope: "instance",
  consumer: "fixture", ui_or_store: "fixture", secret_ref_or_instance_setup: "fixture",
  ticket_or_pr: "fixture", decision: "reviewed",
};
const pattern = {
  id: "example", template: "MYRMIDON_SAMPLE_<NAME>", prefix: "MYRMIDON_SAMPLE_",
  classification: "infra", scope: "instance", source: "fixture", decision: "reviewed",
};
function check(entries = [entry], patterns = [pattern], counts = { unique_names: 1, secret: 0, infra: 1, product: 0 }, extracted = new Map()) {
  return checkRegistry({ registry: { entries, dynamic_patterns: patterns, counts }, extracted });
}

test("valid synthetic registry has no problems", () => assert.deepEqual(check(), []));

for (const field of ["classification", "scope", "consumer", "ui_or_store", "secret_ref_or_instance_setup", "ticket_or_pr", "decision"]) {
  for (const [label, value] of [["missing", undefined], ["empty", ""], ["number", 42], ["pending-audit", "pending-audit"]]) {
    test(`entry ${field} rejects ${label}`, () => {
      const changed = { ...entry, [field]: value };
      const expected = [`MYRMIDON_EXAMPLE: field ${field} is empty or pending-audit`];
      if (field === "classification") expected.push(`MYRMIDON_EXAMPLE: bad classification ${value}`, "counts.infra 1 != 0");
      if (field === "scope") expected.push(`MYRMIDON_EXAMPLE: bad scope ${value}`);
      assert.deepEqual(check([changed]), expected);
    });
  }
}
for (const field of ["id", "template", "prefix", "classification", "scope", "source", "decision"]) {
  for (const [label, value] of [["missing", undefined], ["empty", ""], ["number", 42], ["pending-audit", "pending-audit"]]) {
    test(`dynamic pattern ${field} rejects ${label}`, () => {
      const changed = { ...pattern, [field]: value };
      const id = value === undefined && field === "id" ? "?" : changed.id;
      const expected = [`dynamic pattern ${id}: field ${field} is empty or pending-audit`];
      if (field === "classification") expected.push(`dynamic pattern example: bad classification ${value}`);
      if (field === "scope") expected.push(`dynamic pattern example: bad scope ${value}`);
      assert.deepEqual(check([entry], [changed]), expected);
    });
  }
}
for (const classification of ["secret", "infra", "product"]) {
  test(`classification ${classification} is accepted for entry and pattern`, () => {
    const counts = { unique_names: 1, secret: 0, infra: 0, product: 0, [classification]: 1 };
    assert.deepEqual(check([{ ...entry, classification }], [{ ...pattern, classification }], counts), []);
  });
}
for (const scope of ["instance", "company", "agent", "process", "host", "build-dev"]) {
  test(`scope ${scope} is accepted for entry and pattern`, () => {
    assert.deepEqual(check([{ ...entry, scope }], [{ ...pattern, scope }]), []);
  });
}
test("unknown entry classification is rejected", () => {
  assert.deepEqual(check([{ ...entry, classification: "other" }]), ["MYRMIDON_EXAMPLE: bad classification other", "counts.infra 1 != 0"]);
});
test("unknown entry scope is rejected", () => {
  assert.deepEqual(check([{ ...entry, scope: "other" }]), ["MYRMIDON_EXAMPLE: bad scope other"]);
});
test("unknown pattern classification is rejected", () => {
  assert.deepEqual(check([entry], [{ ...pattern, classification: "other" }]), ["dynamic pattern example: bad classification other"]);
});
test("unknown pattern scope is rejected", () => {
  assert.deepEqual(check([entry], [{ ...pattern, scope: "other" }]), ["dynamic pattern example: bad scope other"]);
});
test("duplicate name is reported", () => {
  assert.deepEqual(check([entry, entry], [pattern], { unique_names: 2, secret: 0, infra: 2, product: 0 }), ["duplicate registry entry MYRMIDON_EXAMPLE"]);
});
test("missing extracted name reports its first location", () => {
  const extracted = new Map([["MYRMIDON_MISSING", { first: { file: "src/example.ts", line: 17 } }]]);
  assert.deepEqual(check([entry], [pattern], undefined, extracted), ["MYRMIDON_MISSING: used in src/example.ts:17 but missing from the registry"]);
});
for (const [field, expected] of [["unique_names", "counts.unique_names 8 != entries 1"], ["secret", "counts.secret 8 != 0"], ["infra", "counts.infra 8 != 1"], ["product", "counts.product 8 != 0"]]) {
  test(`counts.${field} is checked independently`, () => {
    const counts = { unique_names: 1, secret: 0, infra: 1, product: 0, [field]: 8 };
    assert.deepEqual(check([entry], [pattern], counts), [expected]);
  });
}
