import { describe, expect, it } from "vitest";
import {
  STEP_MODEL_CLASSES,
  parseStepModelSelection,
  resolveStepModelSelection,
  stepModelSelectionSchema,
} from "./step-model-selection.js";

const BASE = {
  stepClass: "review" as const,
  agentModel: "fallback-model",
};

describe("resolveStepModelSelection", () => {
  it("exposes exactly the five step classes", () => {
    expect(STEP_MODEL_CLASSES).toEqual([
      "review",
      "acceptance",
      "decomposition",
      "execution",
      "background",
    ]);
  });

  it("prefers the caste rule over the company rule", () => {
    const selection = resolveStepModelSelection({
      ...BASE,
      companyRule: { modelGroup: "company-group", model: "company-model" },
      casteRule: { modelGroup: "caste-group", model: "caste-model" },
    });
    expect(selection.reason).toBe("caste_rule");
    expect(selection.modelGroup).toBe("caste-group");
    expect(selection.model).toBe("caste-model");
  });

  it("uses the company rule when no caste rule exists", () => {
    const selection = resolveStepModelSelection({
      ...BASE,
      companyRule: { modelGroup: "company-group" },
    });
    expect(selection.reason).toBe("company_rule");
    expect(selection.modelGroup).toBe("company-group");
    expect(selection.model).toBe("company-group");
  });

  it("falls back to the agent's effective model when no rule is configured", () => {
    const selection = resolveStepModelSelection({ ...BASE });
    expect(selection.reason).toBe("agent_fallback");
    expect(selection.modelGroup).toBeNull();
    expect(selection.model).toBe("fallback-model");
  });

  it("resolves a named rule group through the provided group catalog", () => {
    const selection = resolveStepModelSelection({
      ...BASE,
      companyRule: { modelGroup: "strong" },
      modelGroups: { strong: "gpt-5.4", economy: "gpt-5.4-mini" },
    });
    expect(selection.model).toBe("gpt-5.4");
    expect(selection.modelGroup).toBe("strong");
  });

  it("ignores empty-string rules and keeps the fallback", () => {
    const selection = resolveStepModelSelection({
      ...BASE,
      companyRule: { modelGroup: "   ", model: "" },
    });
    expect(selection.reason).toBe("agent_fallback");
    expect(selection.modelGroup).toBeNull();
    expect(selection.model).toBe("fallback-model");
  });

  it("rejects an empty agent fallback (the run cannot start unconfigured)", () => {
    expect(() =>
      resolveStepModelSelection({ ...BASE, agentModel: "" }),
    ).toThrow("step_model_agent_fallback_missing");
  });

  it("carries the resolver version and the step class verbatim", () => {
    for (const stepClass of STEP_MODEL_CLASSES) {
      const selection = resolveStepModelSelection({ ...BASE, stepClass });
      expect(selection.resolverVersion).toBe("step-model-v1");
      expect(selection.stepClass).toBe(stepClass);
    }
  });
});

describe("parallel run selection isolation", () => {
  it("keeps each concurrent decision independent when rules change", async () => {
    const rules = { modelGroup: "first", model: "model-a" };
    const first = Promise.resolve().then(() => resolveStepModelSelection({ ...BASE, companyRule: { ...rules } }));
    const second = Promise.resolve().then(() => resolveStepModelSelection({
      ...BASE,
      stepClass: "execution",
      casteRule: { modelGroup: "second", model: "model-b" },
    }));
    const [review, execution] = await Promise.all([first, second]);
    rules.model = "changed";
    expect(review).toMatchObject({ stepClass: "review", modelGroup: "first", model: "model-a", reason: "company_rule" });
    expect(execution).toMatchObject({ stepClass: "execution", modelGroup: "second", model: "model-b", reason: "caste_rule" });
    expect(parseStepModelSelection(review)).toEqual(review);
    expect(parseStepModelSelection(execution)).toEqual(execution);
  });
});

describe("snapshot immutability", () => {
  it("rejects unknown extra keys (no secrets, no free-form growth)", () => {
    expect(
      stepModelSelectionSchema.safeParse({
        stepClass: "review",
        modelGroup: null,
        model: "m",
        reason: "agent_fallback",
        resolverVersion: "step-model-v1",
        OPENAI_API_KEY: "sk-leak",
      }).success,
    ).toBe(false);
  });

  it("parses a stored snapshot back and rejects foreign shapes", () => {
    const snapshot = resolveStepModelSelection({ ...BASE, companyRule: { modelGroup: "strong" } });
    expect(parseStepModelSelection({ ...snapshot })).toEqual(snapshot);
    expect(parseStepModelSelection({ nope: true })).toBeNull();
    expect(parseStepModelSelection(null)).toBeNull();
  });

  it("freezes the snapshot so in-place mutation cannot change history", () => {
    const snapshot = Object.freeze(resolveStepModelSelection(BASE));
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
