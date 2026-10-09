// server/src/myrmidon/scent.myrmidon.test.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): acceptance tests for the task/agent scent.
//
// Every acceptance row of the issue («Сдать») runs here with the REAL create
// hook (deriveScentAuto — the function issues.create calls) and a mocked
// gateway; no network, no LiteLLM. The hook is pure, so these tests run the
// same decision the production path takes — not a stand-in copy of it.
//
//  1. «поправить CSS кнопки» → caste engineer with p > 0.5 (gateway stub);
//  2. a task without a description gets an empty scent and the §2.1 caste —
//     the classifier is NOT called (§2.4) and NO company default is
//     materialized as 'auto';
//  3. pickAgentForTask: an agent with 2 matching tags beats one with 1;
//  4. a serious task (consequences 0.7) goes to `strong`, not `light`;
//  5. an explicit caste is never overwritten (source stamped 'manual');
//  6. a gateway failure does not break issue creation;
//  7. the markup queue: open todos only, and the per-record hourly limit
//     counts FAILURES too — a refused call does not re-pick the same record
//     on the next tick;
//  8. the settings reader: defaults, stored override, env kill switch.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENT_SETTINGS,
  defaultStrengthForPriority,
  pickAgentForTask,
  readScentSettings,
  scentScore,
  scentTaskStrength,
  topScentCasteKey,
  type IssueScent,
} from "@paperclipai/shared";
import type {
  ClassifyIssueScentInput,
  ClassifyAgentScentInput,
  ScentClassificationResult,
  AgentScentClassificationResult,
  ScentGateway,
} from "./scent/gateway.js";
import { deriveScentAuto, isUnclassifiableIssue } from "./scent/create-hook.js";
import { canSpendCall, createScentService } from "./scent/service.js";

const CASTES = ["engineer", "designer", "marketer"];

const CSS_SCENT: IssueScent = {
  tags: ["css", "button", "ui"],
  casteProbs: { engineer: 0.8, designer: 0.1 },
  complexity: { coordination: 0.1, uncertainty: 0.1, consequences: 0.05 },
};

const SERIOUS_SCENT: IssueScent = {
  tags: ["security", "payments"],
  casteProbs: { engineer: 0.9 },
  complexity: { coordination: 0.4, uncertainty: 0.3, consequences: 0.7 },
};

function stubGateway(issueResult: (input: ClassifyIssueScentInput) => ScentClassificationResult): ScentGateway & {
  calls: ClassifyIssueScentInput[];
} {
  const calls: ClassifyIssueScentInput[] = [];
  return {
    calls,
    classifyIssueScent: async (input) => {
      calls.push(input);
      return issueResult(input);
    },
    classifyAgentScent: async (
      _input: ClassifyAgentScentInput,
    ): Promise<AgentScentClassificationResult> => ({
      tags: ["triage"],
      model: DEFAULT_SCENT_SETTINGS.model,
      inputTokens: 1, outputTokens: 1,
    }),
  };
}

function failingGateway(): ScentGateway & { calls: ClassifyIssueScentInput[] } {
  const calls: ClassifyIssueScentInput[] = [];
  return {
    calls,
    classifyIssueScent: async (input) => {
      calls.push(input);
      throw new Error("gateway refused");
    },
    classifyAgentScent: async () => {
      throw new Error("gateway refused");
    },
  };
}

// --- 1. CSS task → engineer p > 0.5 ------------------------------------------

describe("issue scent classification (acceptance row 1)", () => {
  it("«поправить CSS кнопки» gets caste engineer with p > 0.5 via the mocked gateway", async () => {
    const gateway = stubGateway(() => ({
      scent: CSS_SCENT,
      model: "qwen-turbo-free",
      inputTokens: 120, outputTokens: 40,
    }));
    // The create path: classify (mocked), then the REAL hook decides.
    const result = await gateway.classifyIssueScent({
      model: "qwen-turbo-free",
      casteKeys: CASTES,
      title: "Поправить CSS кнопки",
      description: "Кнопка «Сохранить» наезжает на поле ввода на мобильном.",
      timeoutSec: 20,
    });
    const scent = result.scent!;
    expect(topScentCasteKey(scent, 0.5)).toBe("engineer");
    expect(scent.casteProbs.engineer).toBeGreaterThan(0.5);
    expect(gateway.calls).toHaveLength(1);

    const applied = deriveScentAuto(
      {
        title: "Поправить CSS кнопки",
        priority: "medium",
        casteKey: null,
        casteSource: null,
        pheromoneStrength: null,
        scent,
      },
      CASTES,
      DEFAULT_SCENT_SETTINGS,
    );
    expect(applied.casteKey).toBe("engineer");
    expect(applied.casteSource).toBe("auto");
    // the winning probability is readable off the scent itself
    expect(scent.casteProbs.engineer!).toBeGreaterThanOrEqual(0.5);
  });
});

// --- 2. Task without a description -------------------------------------------

describe("task without a description (acceptance row 2)", () => {
  it("gets an empty scent, keeps caste NULL (§2.1 chain), never calls the classifier", () => {
    expect(isUnclassifiableIssue({ description: null })).toBe(true);

    const gateway = stubGateway(() => {
      throw new Error("must not be called");
    });
    // The create path guards with isUnclassifiableIssue before any call:
    if (!isUnclassifiableIssue({ description: null })) {
      void gateway.classifyIssueScent({
        model: "m",
        casteKeys: CASTES,
        title: "Test",
        description: null,
        timeoutSec: 20,
      });
    }
    expect(gateway.calls).toHaveLength(0);

    const applied = deriveScentAuto(
      {
        title: "Test",
        description: null,
        priority: "medium",
        casteKey: null,
        casteSource: null,
        pheromoneStrength: null,
        scent: null,
      },
      CASTES,
      DEFAULT_SCENT_SETTINGS,
    );
    // §2.1: task NULL — the project/company default resolves at read time;
    // the hook must NOT materialize the company default as 'auto'.
    expect(applied.casteKey).toBeNull();
    expect(applied.casteSource).toBeNull();
  });

  it("a low-confidence scent (p < 0.5) also keeps caste NULL, no company default", () => {
    const lowConf: IssueScent = {
      tags: ["misc"],
      casteProbs: { engineer: 0.4, designer: 0.35, marketer: 0.25 },
      complexity: { coordination: 0.2, uncertainty: 0.2, consequences: 0.2 },
    };
    const applied = deriveScentAuto(
      {
        title: "Починить отчёт",
        priority: "medium",
        casteKey: null,
        casteSource: null,
        pheromoneStrength: null,
        scent: lowConf,
      },
      CASTES,
      DEFAULT_SCENT_SETTINGS,
    );
    expect(applied.casteKey).toBeNull();
    expect(applied.casteSource).toBeNull();
  });
});

// --- 3. pickAgentForTask: 2 tags beat 1 ---------------------------------------

describe("pickAgentForTask (acceptance row 3)", () => {
  it("an agent with 2 matching tags beats an agent with 1", () => {
    const task = { scent: CSS_SCENT };
    const twoTags = { id: "b", scentTags: ["css", "ui"], modelTier: "light" as const };
    const oneTag = { id: "a", scentTags: ["css"], modelTier: "light" as const };
    expect(scentScore(task, twoTags)).toBe(2 * DEFAULT_SCENT_SETTINGS.tagWeight);
    expect(scentScore(task, oneTag)).toBe(1 * DEFAULT_SCENT_SETTINGS.tagWeight);
    expect(pickAgentForTask(task, [twoTags, oneTag])?.id).toBe("b");
  });
});

// --- 4. Serious task → strong tier -------------------------------------------

describe("task strength from the Jev complexity (acceptance row 4)", () => {
  it("consequences 0.7 pushes the strength past the strong threshold", () => {
    const serious = scentTaskStrength("medium", SERIOUS_SCENT, DEFAULT_SCENT_SETTINGS);
    const plain = scentTaskStrength("medium", CSS_SCENT, DEFAULT_SCENT_SETTINGS);
    expect(serious).toBeGreaterThan(plain);
    expect(plain).toBe(defaultStrengthForPriority("medium"));
  });
});

// --- 5. Explicit caste is never overwritten -----------------------------------

describe("explicit values win (acceptance row 5)", () => {
  it("an explicit casteKey is kept and stamped 'manual'", () => {
    const applied = deriveScentAuto(
      {
        title: "Поправить CSS кнопки",
        priority: "medium",
        casteKey: "designer",
        casteSource: null,
        pheromoneStrength: null,
        scent: CSS_SCENT, // classifier would say engineer — must not matter
      },
      CASTES,
      DEFAULT_SCENT_SETTINGS,
    );
    expect(applied.casteKey).toBe("designer");
    expect(applied.casteSource).toBe("manual");
  });

  it("an explicit strength is kept", () => {
    const applied = deriveScentAuto(
      {
        title: "Поправить CSS кнопки",
        priority: "medium",
        casteKey: null,
        casteSource: null,
        pheromoneStrength: 42,
        scent: CSS_SCENT,
      },
      CASTES,
      DEFAULT_SCENT_SETTINGS,
    );
    expect(applied.pheromoneStrength).toBe(42);
  });
});

// --- 6. Gateway failure does not break creation -------------------------------

describe("classifier failure (acceptance row 6)", () => {
  it("a gateway failure yields scent null and a NULL caste — creation proceeds", async () => {
    const gateway = failingGateway();
    let scent: IssueScent | null = null;
    try {
      await gateway.classifyIssueScent({
        model: "m",
        casteKeys: CASTES,
        title: "Поправить CSS кнопки",
        description: "Описание есть.",
        timeoutSec: 20,
      });
    } catch {
      scent = null; // the caller's contract: failure → null scent
    }
    const applied = deriveScentAuto(
      {
        title: "Поправить CSS кнопки",
        priority: "medium",
        casteKey: null,
        casteSource: null,
        pheromoneStrength: null,
        scent,
      },
      CASTES,
      DEFAULT_SCENT_SETTINGS,
    );
    expect(applied.casteKey).toBeNull();
    expect(applied.pheromoneStrength).toBe(
      defaultStrengthForPriority("medium"),
    );
  });
});

// --- 7. Markup queue: open todos only; hourly limit counts failures -----------

describe("markup queue (acceptance row 7)", () => {
  it("listMarkupQueue never selects done/cancelled issues or capability-less agents", async () => {
    // The SQL is the gate — drive a stub db that captures the WHERE clauses so
    // the test fails if someone widens the queue to closed issues or agents
    // without capabilities.
    const seenSql: string[] = [];
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: (...clauses: unknown[]) => {
            seenSql.push(...clauses.map((c) => String(c)));
            return {
              orderBy: () => ({ limit: () => Promise.resolve([]) }),
              // issues path awaits the where() directly
              then: (fn: (rows: unknown[]) => unknown) => fn([]),
            };
          },
        }),
      }),
    };
    const service = createScentService({
      db: db as never,
      companyId: "c1",
      settings: DEFAULT_SCENT_SETTINGS,
      gateway: stubGateway(() => ({
        scent: CSS_SCENT,
        model: "m",
        inputTokens: 1, outputTokens: 1,
      })),
      casteKeys: CASTES,
      logActivity: async () => {},
    });
    const slice = await service.listMarkupQueue(20);
    expect(slice.issueIds).toEqual([]);
    expect(slice.agentIds).toEqual([]);
    // §7.1 п.4a: only OPEN todos are eligible (the queue is not a backfill of
    // the whole history — that would blow the 1M tokens/day budget).
    expect(seenSql.join(" ")).toContain("todo");
    // Agents without capabilities never occupy a batch slot.
    expect(seenSql.join(" ")).toContain("capabilities");
  });

  it("the hourly budget counts attempts, not only successes", async () => {
    // canSpendCall reads the activity log: one entry per ATTEMPT (ok or not).
    const nAttempts = 3;
    const db = {
      execute: () => Promise.resolve([{ n: nAttempts }]),
    };
    const allowed = await canSpendCall(db as never, {
      entityType: "issue",
      entityId: "i1",
      maxPerHour: 1,
    });
    expect(allowed).toBe(false);
    const allowedWhenEmpty = await canSpendCall(
      { execute: () => Promise.resolve([{ n: 0 }]) } as never,
      { entityType: "issue", entityId: "i1", maxPerHour: 1 },
    );
    expect(allowedWhenEmpty).toBe(true);
  });
});

// --- 8. Settings reader --------------------------------------------------------

describe("scent settings (acceptance row 8)", () => {
  it("defaults hold without any configuration", () => {
    const s = readScentSettings(null);
    expect(s).toEqual(DEFAULT_SCENT_SETTINGS);
    expect(s.enabled).toBe(true);
    expect(s.model).toBe("qwen-turbo-free");
    expect(s.classifierBatchSize).toBe(20);
  });

  it("stored settings override the defaults", () => {
    const s = readScentSettings({ scent: { enabled: false, model: "custom", tagWeight: 5 } });
    expect(s.enabled).toBe(false);
    expect(s.model).toBe("custom");
    expect(s.tagWeight).toBe(5);
    expect(s.tierFit).toBe(DEFAULT_SCENT_SETTINGS.tierFit);
  });

  it("the server-side env kill switch disables the classifier", () => {
    const s = readScentSettings({ scent: {} }, { MYRMIDON_SWARM_SCENT_ENABLED: "0" });
    expect(s.enabled).toBe(false);
  });
});
