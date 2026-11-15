import { describe, expect, it } from "vitest";
import {
  RUN_STEP_CLASSES,
  hasDuplicateModelGroupRules,
  resolveModelGroupForStep,
  ruleScopeKey,
  saveCompanyModelGroupRulesSchema,
  companyModelGroupRuleSchema,
  unknownModelGroupsInRules,
  type CompanyModelGroupRule,
  type RunStepClass,
} from "./myrmidon-model-group-rules.js";

/**
 * myrmidon(1.8 MODEL-BY-STEP, OPE-12997): the settings contract of the
 * company model-group rules. The precedence of `resolveModelGroupForStep` is
 * THE feature: caste override > company rule > null, and an unknown caste or
 * class never invents a group.
 */

const company = (stepClass: RunStepClass, modelGroup: string): CompanyModelGroupRule => ({
  stepClass,
  modelGroup,
  casteKey: null,
});
const caste = (casteKey: string, stepClass: RunStepClass, modelGroup: string): CompanyModelGroupRule => ({
  stepClass,
  modelGroup,
  casteKey,
});

describe("run step classes", () => {
  it("exposes the epic's five classes in ladder order", () => {
    expect([...RUN_STEP_CLASSES]).toEqual([
      "review",
      "acceptance",
      "decomposition",
      "execution",
      "background",
    ]);
  });
});

describe("saveCompanyModelGroupRulesSchema", () => {
  it("accepts company-wide and caste rules", () => {
    const parsed = saveCompanyModelGroupRulesSchema.safeParse({
      rules: [
        company("review", "strong-group"),
        caste("engineer", "execution", "economy-group"),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown step class", () => {
    const parsed = saveCompanyModelGroupRulesSchema.safeParse({
      rules: [{ stepClass: "deploy", modelGroup: "strong-group", casteKey: null } as unknown as CompanyModelGroupRule],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty group name", () => {
    const parsed = saveCompanyModelGroupRulesSchema.safeParse({
      rules: [company("review", "  ")],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects extra keys (strict body)", () => {
    const parsed = saveCompanyModelGroupRulesSchema.safeParse({
      rules: [],
      surprise: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("normalizes the caste key to the directory vocabulary", () => {
    const parsed = companyModelGroupRuleSchema.safeParse(
      caste("Engineer", "execution", "economy-group"),
    );
    expect(parsed.success && parsed.data.casteKey).toBe("engineer");
  });
});

describe("hasDuplicateModelGroupRules", () => {
  it("flags two rules of one scope", () => {
    expect(
      hasDuplicateModelGroupRules([
        company("review", "a"),
        company("review", "b"),
      ]),
    ).toBe(true);
  });

  it("allows the same class under different scopes", () => {
    expect(
      hasDuplicateModelGroupRules([
        company("review", "a"),
        caste("engineer", "review", "b"),
      ]),
    ).toBe(false);
  });

  it("allows different classes in one scope", () => {
    expect(
      hasDuplicateModelGroupRules([
        company("review", "a"),
        company("execution", "b"),
      ]),
    ).toBe(false);
  });
});

describe("resolveModelGroupForStep — precedence", () => {
  const rules = [
    company("review", "company-strong"),
    company("execution", "company-work"),
    caste("engineer", "execution", "engineer-cheap"),
    caste("reviewer", "review", "reviewer-best"),
  ];

  it("the caste override wins over the company rule", () => {
    expect(resolveModelGroupForStep(rules, "execution", "engineer")).toBe(
      "engineer-cheap",
    );
  });

  it("the company rule answers when the caste has no override for the class", () => {
    expect(resolveModelGroupForStep(rules, "execution", "reviewer")).toBe(
      "company-work",
    );
  });

  it("a caste override does not leak into other castes", () => {
    expect(resolveModelGroupForStep(rules, "execution", "cmo")).toBe(
      "company-work",
    );
  });

  it("an unset class answers null, never a group", () => {
    expect(resolveModelGroupForStep(rules, "background", "engineer")).toBeNull();
    expect(resolveModelGroupForStep(rules, "background")).toBeNull();
  });

  it("an unknown caste falls through to the company rule", () => {
    expect(resolveModelGroupForStep(rules, "review", "ghost")).toBe(
      "company-strong",
    );
  });

  it("an override still answers without any company rule", () => {
    expect(resolveModelGroupForStep([caste("cmo", "review", "best")], "review", "cmo")).toBe(
      "best",
    );
  });
});

describe("unknownModelGroupsInRules — catalog validation", () => {
  it("returns the unknown groups in first-seen order without duplicates", () => {
    expect(
      unknownModelGroupsInRules(
        [company("review", "ghost"), company("execution", "real"), caste("cmo", "review", "ghost")],
        ["real"],
      ),
    ).toEqual(["ghost"]);
  });

  it("accepts everything when every group is known", () => {
    expect(
      unknownModelGroupsInRules([company("review", "a")], ["a", "b"]),
    ).toEqual([]);
  });

  it("validates nothing against an empty catalog", () => {
    expect(unknownModelGroupsInRules([company("review", "a")], [])).toEqual(["a"]);
  });
});

describe("ruleScopeKey", () => {
  it("separates the company scope from a caste scope", () => {
    expect(ruleScopeKey({ stepClass: "review" })).not.toBe(
      ruleScopeKey({ casteKey: "engineer", stepClass: "review" }),
    );
  });
});
