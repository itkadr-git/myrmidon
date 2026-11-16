import assert from "node:assert/strict";
import test from "node:test";
import { validateScenario } from "../../check-acceptance-scenarios.mjs";

const valid = () => ({ id: "scenario-id", title: "Scenario title", falsifiedWhen: "It fails" });

function check(scenario, expected) {
  const before = structuredClone(scenario);
  assert.deepEqual(validateScenario(scenario, 7), expected);
  assert.deepEqual(scenario, before, "validation must not mutate the scenario");
}

for (const field of ["id", "title", "falsifiedWhen"]) {
  test(`${field}: missing is rejected`, () => {
    const scenario = valid();
    delete scenario[field];
    check(scenario, [`scenario[7]: missing or empty required field "${field}"`]);
  });
  test(`${field}: whitespace is rejected`, () => {
    const errors = [`scenario[7]: missing or empty required field "${field}"`];
    if (field === "id") errors.push('scenario[7]: "id" must be a non-empty string');
    check({ ...valid(), [field]: " \t " }, errors);
  });
  test(`${field}: non-empty string is accepted`, () => {
    check({ ...valid(), [field]: " valid " }, []);
  });
}

test("id: array is rejected", () => {
  check({ ...valid(), id: ["id"] }, ['scenario[7]: "id" must be a non-empty string']);
});

test("falsifiedWhen: non-empty string array is accepted", () => {
  check({ ...valid(), falsifiedWhen: ["first", "second"] }, []);
});
for (const [name, value] of [["empty array", []], ["mixed array", ["valid", 1]], ["blank array item", ["valid", "  "]]]) {
  test(`falsifiedWhen: ${name} is rejected`, () => {
    check({ ...valid(), falsifiedWhen: value }, ['scenario[7]: missing or empty required field "falsifiedWhen"']);
  });
}

for (const field of ["given", "when", "then"]) {
  for (const [name, value] of [["string", "text"], ["string array", ["first", "second"]]]) {
    test(`${field}: ${name} is accepted`, () => check({ ...valid(), [field]: value }, []));
  }
  for (const [name, value] of [["blank", "  "], ["empty array", []], ["mixed array", ["text", 1]], ["blank array item", ["text", " "]], ["number", 1]]) {
    test(`${field}: ${name} is rejected`, () => {
      check({ ...valid(), [field]: value }, [`scenario[7]: "${field}" must be a non-empty string or a non-empty array of strings`]);
    });
  }
}

test("description: string is accepted", () => check({ ...valid(), description: "description" }, []));
test("description: non-string is rejected", () => {
  check({ ...valid(), description: ["description"] }, ['scenario[7]: "description" must be a string']);
});
test("tags: empty array is accepted", () => check({ ...valid(), tags: [] }, []));
test("tags: non-empty string array is accepted", () => check({ ...valid(), tags: ["one", "two"] }, []));
for (const [name, value] of [["mixed array", ["tag", 1]], ["blank tag", ["tag", "  "]], ["string", "tag"]]) {
  test(`tags: ${name} is rejected`, () => {
    check({ ...valid(), tags: value }, ['scenario[7]: "tags" must be an array of non-empty strings']);
  });
}
test("unknown scenario field is rejected", () => {
  check({ ...valid(), extra: true }, ['scenario[7]: unknown field "extra"']);
});
