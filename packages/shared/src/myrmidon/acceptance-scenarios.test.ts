import { describe, expect, it } from \"vitest\";
import {
  ISSUE_ACCEPTANCE_SCENARIOS_DOCUMENT_KEY,
  acceptanceScenarioSchema,
  acceptanceScenariosDocumentSchema,
  isAcceptanceScenario,
  parseAcceptanceScenario,
  parseAcceptanceScenarios,
  parseAcceptanceScenariosDocument,
} from \"./acceptance-scenarios.js\";

describe(\"acceptance-scenarios contract (OPE-12172)\", () => {
  it(\"exports the expected document key constant\", () => {
    expect(ISSUE_ACCEPTANCE_SCENARIOS_DOCUMENT_KEY).toBe(\"acceptance-scenarios\");
  });

  it(\"validates a complete scenario with all standard fields\", () => {
    const raw = {
      id: \"SCEN-001\",
      title: \"Document key export check\",
      given: \"packages/shared is imported\",
      when: \"accessing ISSUE_ACCEPTANCE_SCENARIOS_DOCUMENT_KEY\",
      then: \"constant equals 'acceptance-scenarios'\",
      falsifiedWhen: \"constant is undefined or not 'acceptance-scenarios'\",
      testRefs: [\"packages/shared/src/exports.test.ts\"],
    };

    const parsed = parseAcceptanceScenario(raw);
    expect(parsed.id).toBe(\"SCEN-001\");
    expect(parsed.title).toBe(\"Document key export check\");
    expect(parsed.falsifiedWhen).toBe(\"constant is undefined or not 'acceptance-scenarios'\");
    expect(parsed.testRefs).toEqual([\"packages/shared/src/exports.test.ts\"]);
    expect(isAcceptanceScenario(raw)).toBe(true);
  });

  it(\"rejects a scenario missing falsifiedWhen (falsifiedWhen is required)\", () => {
    const withoutFalsifiedWhen: any = {
      id: \"SCEN-002\",
      title: \"Scenario missing falsifiedWhen\",
      given: \"system ready\",
      when: \"doing action\",
      then: \"expected state\",
      testRefs: [\"test.ts\"],
    };

    expect(isAcceptanceScenario(withoutFalsifiedWhen)).toBe(false);
    expect(() => parseAcceptanceScenario(withoutFalsifiedWhen)).toThrow();
  });

  it(\"rejects a scenario with empty falsifiedWhen string or empty array\", () => {
    expect(() =>
      parseAcceptanceScenario({
        id: \"SCEN-003\",
        title: \"Empty falsifiedWhen\",
        falsifiedWhen: \"\",
      }),
    ).toThrow();

    expect(() =>
      parseAcceptanceScenario({
        id: \"SCEN-004\",
        title: \"Empty array falsifiedWhen\",
        falsifiedWhen: [],
      }),
    ).toThrow();
  });

  it(\"defaults testRefs to empty array when omitted\", () => {
    const parsed = parseAcceptanceScenario({
      id: \"SCEN-005\",
      title: \"Minimal scenario\",
      falsifiedWhen: \"system crashes\",
    });
    expect(parsed.testRefs).toEqual([]);
  });

  it(\"supports structured testRefs objects\", () => {
    const parsed = parseAcceptanceScenario({
      id: \"SCEN-006\",
      title: \"Structured test ref\",
      falsifiedWhen: \"test fails\",
      testRefs: [
        \"simple/path.test.ts\",
        {
          path: \"packages/shared/src/exports.test.ts\",
          suite: \"acceptance-scenarios\",
          testName: \"exports the expected document key\",
          line: 12,
        },
      ],
    });
    expect(parsed.testRefs).toHaveLength(2);
  });

  it(\"supports array of conditions for given/when/then/falsifiedWhen\", () => {
    const parsed = parseAcceptanceScenario({
      id: \"SCEN-007\",
      title: \"Multi-condition scenario\",
      given: [\"condition A\", \"condition B\"],
      when: [\"step 1\", \"step 2\"],
      then: [\"result 1\", \"result 2\"],
      falsifiedWhen: [\"failure mode 1\", \"failure mode 2\"],
    });
    expect(parsed.given).toEqual([\"condition A\", \"condition B\"]);
    expect(parsed.falsifiedWhen).toEqual([\"failure mode 1\", \"failure mode 2\"]);
  });

  it(\"parses acceptance scenarios document wrappers and arrays\", () => {
    const scenario = {
      id: \"SCEN-010\",
      title: \"Document wrapper test\",
      falsifiedWhen: \"wrapper fails\",
      testRefs: [],
    };

    const doc = acceptanceScenariosDocumentSchema.parse({
      version: 1,
      epicKey: \"OPE-12139\",
      scenarios: [scenario],
    });
    expect(doc.version).toBe(1);
    expect(doc.scenarios).toHaveLength(1);

    // parseAcceptanceScenarios from document object
    const fromDoc = parseAcceptanceScenarios(doc);
    expect(fromDoc).toHaveLength(1);
    expect(fromDoc[0].id).toBe(\"SCEN-010\");

    // parseAcceptanceScenarios from raw array
    const fromArray = parseAcceptanceScenarios([scenario]);
    expect(fromArray).toHaveLength(1);

    // parseAcceptanceScenarios from JSON string
    const fromJson = parseAcceptanceScenarios(JSON.stringify(doc));
    expect(fromJson).toHaveLength(1);

    // parseAcceptanceScenariosDocument from array
    const docFromArray = parseAcceptanceScenariosDocument([scenario]);
    expect(docFromArray.version).toBe(1);
    expect(docFromArray.scenarios).toHaveLength(1);
  });
});
