// packages/shared/src/myrmidon-scent.test.ts
//
// myrmidon(1.6.5 F-26 T10): the pure scent contract — score, pick, strength,
// top-caste, settings. Acceptance rows from tasks.md T10 «Сдать»:
//  - an agent with 2 matching tags beats an agent with 1;
//  - a serious task (consequences 0.7) goes to `strong`, not `light`;
//  - tie → the smaller agent id;
//  - a task without scent scores 0 for everyone.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENT_SETTINGS,
  DEFAULT_SCENT_WEIGHTS,
  defaultStrengthForPriority,
  issueScentSchema,
  pickAgentForTask,
  readScentSettings,
  scentScore,
  scentTaskStrength,
  scentTopCaste,
  topScentCasteKey,
  type IssueScent,
  type ScentAgent,
} from "./myrmidon-scent.js";
import { DEFAULT_PHEROMONE_STRENGTH_BY_PRIORITY } from "./myrmidon-swarm-claim.js";

const SCENT: IssueScent = {
  tags: ["css", "ui", "frontend"],
  casteProbs: { engineer: 0.7, designer: 0.2, qa: 0.1 },
  complexity: { coordination: 0.1, uncertainty: 0.2, consequences: 0.3 },
};

function agent(id: string, tags: string[], modelTier: "light" | "strong" = "strong"): ScentAgent {
  return { id, scentTags: tags, modelTier };
}

describe("issueScentSchema", () => {
  it("accepts the stored shape and caps the tag list at 8", () => {
    expect(issueScentSchema.parse(SCENT)).toEqual(SCENT);
    expect(
      issueScentSchema.safeParse({ ...SCENT, tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })
        .success,
    ).toBe(false);
  });

  it("rejects a caste probability outside [0,1] and a non-integer count", () => {
    expect(
      issueScentSchema.safeParse({ ...SCENT, casteProbs: { engineer: 1.2 } }).success,
    ).toBe(false);
    expect(
      issueScentSchema.safeParse({
        ...SCENT,
        complexity: { coordination: 0.1, uncertainty: 0.2, consequences: 1.01 },
      }).success,
    ).toBe(false);
  });
});

describe("scentScore", () => {
  it("counts matching tags times tagWeight", () => {
    expect(scentScore({ scent: SCENT }, agent("a", ["css", "ui"]))).toBe(
      2 * DEFAULT_SCENT_WEIGHTS.tagWeight,
    );
    expect(scentScore({ scent: SCENT }, agent("a", ["css"]))).toBe(
      DEFAULT_SCENT_WEIGHTS.tagWeight,
    );
  });

  it("a serious task (consequences 0.7) fits strong, not light", () => {
    const serious: IssueScent = {
      ...SCENT,
      complexity: { coordination: 0.4, uncertainty: 0.3, consequences: 0.7 },
    };
    const strongScore = scentScore({ scent: serious }, agent("a", [], "strong"));
    const lightScore = scentScore({ scent: serious }, agent("a", [], "light"));
    expect(strongScore).toBe(DEFAULT_SCENT_WEIGHTS.tierFit);
    expect(lightScore).toBe(0);
  });

  it("a task without a scent scores 0 for everyone", () => {
    expect(scentScore({ scent: null }, agent("a", ["css"]))).toBe(0);
  });
});

describe("pickAgentForTask", () => {
  it("picks the highest score; tie → the smaller id", () => {
    const task = { scent: SCENT };
    const a = agent("b-id", ["css", "ui"]);
    const b = agent("a-id", ["css", "ui"]);
    expect(pickAgentForTask(task, [a, b])).toBe("a-id");
    expect(pickAgentForTask(task, [b, a])).toBe("a-id");
  });

  it("an agent with 2 matching tags beats an agent with 1", () => {
    const task = { scent: SCENT };
    expect(
      pickAgentForTask(task, [agent("x", ["css"]), agent("y", ["css", "frontend"])]),
    ).toBe("y");
  });

  it("no candidates → null", () => {
    expect(pickAgentForTask({ scent: SCENT }, [])).toBeNull();
  });
});

describe("scentTaskStrength / defaultStrengthForPriority", () => {
  it("consequences ≥ 0.65 adds the consequences bonus", () => {
    const serious: IssueScent = {
      ...SCENT,
      complexity: { coordination: 0.4, uncertainty: 0.3, consequences: 0.7 },
    };
    const base = DEFAULT_PHEROMONE_STRENGTH_BY_PRIORITY.medium;
    expect(scentTaskStrength("medium", serious)).toBe(
      base + DEFAULT_SCENT_SETTINGS.consequencesBonus,
    );
    expect(scentTaskStrength("medium", SCENT)).toBe(base);
    expect(scentTaskStrength("medium", null)).toBe(base);
    expect(defaultStrengthForPriority("medium")).toBe(base);
    expect(defaultStrengthForPriority("critical")).toBe(
      DEFAULT_PHEROMONE_STRENGTH_BY_PRIORITY.critical,
    );
  });
});

describe("top-caste helpers", () => {
  it("scentTopCaste returns the argmax; ties break on the key", () => {
    expect(scentTopCaste(SCENT)).toEqual({ key: "engineer", p: 0.7 });
    expect(
      scentTopCaste({ ...SCENT, casteProbs: { b: 0.5, a: 0.5 } }),
    ).toEqual({ key: "a", p: 0.5 });
    expect(scentTopCaste(null)).toBeNull();
    expect(scentTopCaste({ ...SCENT, casteProbs: {} })).toBeNull();
  });

  it("topScentCasteKey gates on minP (design §2.4 п.2)", () => {
    expect(topScentCasteKey(SCENT, 0.5)).toBe("engineer");
    expect(
      topScentCasteKey({ ...SCENT, casteProbs: { engineer: 0.49, designer: 0.3 } }, 0.5),
    ).toBeNull();
  });
});

describe("readScentSettings", () => {
  it("defaults hold without configuration", () => {
    const s = readScentSettings(null);
    expect(s).toEqual(DEFAULT_SCENT_SETTINGS);
    expect(s.enabled).toBe(true);
    expect(s.model).toBe("qwen-turbo-free");
  });

  it("stored settings override defaults", () => {
    const s = readScentSettings({ scent: { enabled: false, tagWeight: 5 } });
    expect(s.enabled).toBe(false);
    expect(s.tagWeight).toBe(5);
  });

  it("server passes the env kill switch explicitly (shared never reads process.env)", () => {
    expect(readScentSettings({ scent: {} }, { MYRMIDON_SWARM_SCENT_ENABLED: "0" }).enabled).toBe(
      false,
    );
    expect(readScentSettings({ scent: {} }, { MYRMIDON_SWARM_SCENT_ENABLED: "false" }).enabled).toBe(
      false,
    );
    expect(readScentSettings({ scent: {} }, {}).enabled).toBe(true);
  });
});
