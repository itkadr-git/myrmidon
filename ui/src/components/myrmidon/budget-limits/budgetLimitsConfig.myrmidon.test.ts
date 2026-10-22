// myrmidon(1.7 BUDGET-CONFIG D): unit tests of the pure helpers behind the
// "Budgets" screen — the tree the owner sees, the amount/ref parsing and the
// label keys. No DOM, no network.
import { describe, expect, it } from "vitest";
import {
  BUDGET_LIMIT_AMOUNT_MAX_CENTS,
  budgetLimitKey,
  buildBudgetLimitTree,
  centsToAmountText,
  flattenBudgetLimitTree,
  formatCents,
  levelLabelKey,
  modeLabelKey,
  nodeRefText,
  parseAmountToCents,
  parseRefForLevel,
  periodLabelKey,
  signalOnlySourceLabelKey,
  usagePercent,
} from "./budgetLimitsConfig";
import type { BudgetLimitUsageRow, BudgetLimitView } from "./budgetLimitsApi";

function limit(overrides: Partial<BudgetLimitView> & Pick<BudgetLimitView, "level" | "ref">): BudgetLimitView {
  return {
    id: `id-${overrides.level}-${overrides.ref}`,
    companyId: "company-1",
    amountCents: 1000,
    period: "calendar_month_utc",
    mode: "hard",
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function usage(row: BudgetLimitView, spentCents: number, overLimit = false): BudgetLimitUsageRow {
  return { ...row, spentCents, events: 1, overLimit };
}

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_PROJECT_ID = "99999999-8888-7777-6666-555555555555";
const ISSUE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("formatCents", () => {
  it("renders integer cents as dollars with two decimals", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(1250)).toBe("$12.50");
  });

  it("groups thousands and keeps the sign", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(-1250)).toBe("-$12.50");
  });
});

describe("centsToAmountText / parseAmountToCents", () => {
  it("round-trips an amount draft", () => {
    expect(centsToAmountText(1250)).toBe("12.50");
    expect(parseAmountToCents("12.50")).toEqual({ ok: true, cents: 1250 });
    expect(parseAmountToCents("12.5")).toEqual({ ok: true, cents: 1250 });
    expect(centsToAmountText(null)).toBe("");
  });

  it("accepts a currency sign, the English grouping and a comma decimal", () => {
    expect(parseAmountToCents("$1,234.56")).toEqual({ ok: true, cents: 123456 });
    expect(parseAmountToCents("1,234")).toEqual({ ok: true, cents: 123400 });
    // "12,50" is the RU way to type twelve fifty, not a malformed grouping.
    expect(parseAmountToCents("12,50")).toEqual({ ok: true, cents: 1250 });
  });

  it("rounds half-up at the third decimal — the store keeps integer cents", () => {
    expect(parseAmountToCents("0.005")).toEqual({ ok: true, cents: 1 });
    expect(parseAmountToCents("0.004")).toEqual({ ok: true, cents: 0 });
  });

  it("refuses an empty, non-numeric or out-of-range amount with a message key", () => {
    expect(parseAmountToCents("")).toEqual({ ok: false, messageKey: "budgetLimits.amountRequired" });
    expect(parseAmountToCents("12,50,00")).toEqual({ ok: false, messageKey: "budgetLimits.amountInvalid" });
    expect(parseAmountToCents("abc")).toEqual({ ok: false, messageKey: "budgetLimits.amountInvalid" });
    expect(parseAmountToCents("-5")).toEqual({ ok: false, messageKey: "budgetLimits.amountInvalid" });
    expect(parseAmountToCents(String(BUDGET_LIMIT_AMOUNT_MAX_CENTS / 100 + 1))).toEqual({
      ok: false,
      messageKey: "budgetLimits.amountRange",
    });
    expect(parseAmountToCents(String(BUDGET_LIMIT_AMOUNT_MAX_CENTS / 100))).toEqual({
      ok: true,
      cents: BUDGET_LIMIT_AMOUNT_MAX_CENTS,
    });
  });
});

describe("parseRefForLevel", () => {
  it("mirrors the API ref rules per level", () => {
    expect(parseRefForLevel("nest", "company")).toEqual({ ok: true, ref: "company" });
    expect(parseRefForLevel("nest", PROJECT_ID)).toEqual({ ok: true, ref: PROJECT_ID });
    expect(parseRefForLevel("nest", "not-a-uuid")).toEqual({ ok: false, messageKey: "budgetLimits.refErrorNest" });

    expect(parseRefForLevel("caste", "engineer")).toEqual({ ok: true, ref: "engineer" });
    expect(parseRefForLevel("caste", "Engineer")).toEqual({ ok: false, messageKey: "budgetLimits.refErrorCaste" });

    expect(parseRefForLevel("foraging", "foraging")).toEqual({ ok: true, ref: "foraging" });
    expect(parseRefForLevel("foraging", "pass")).toEqual({ ok: false, messageKey: "budgetLimits.refErrorForaging" });

    expect(parseRefForLevel("issue", ISSUE_ID)).toEqual({ ok: true, ref: ISSUE_ID });
    expect(parseRefForLevel("issue", "task-1")).toEqual({ ok: false, messageKey: "budgetLimits.refErrorIssue" });
  });

  it("trims and refuses an over-long ref", () => {
    expect(parseRefForLevel("caste", "  engineer  ")).toEqual({ ok: true, ref: "engineer" });
    expect(parseRefForLevel("caste", "x".repeat(129))).toEqual({ ok: false, messageKey: "budgetLimits.refErrorLength" });
    expect(parseRefForLevel("caste", "")).toEqual({ ok: false, messageKey: "budgetLimits.refErrorLength" });
  });
});

describe("usagePercent", () => {
  it("reads as a share of the limit and caps at 100", () => {
    expect(usagePercent(2500, 10000)).toBe(25);
    expect(usagePercent(9999, 10000)).toBe(100);
    expect(usagePercent(20000, 10000)).toBe(100);
  });

  it("is null without a limit, with spend 0 and for a zero limit", () => {
    expect(usagePercent(null, 10000)).toBeNull();
    expect(usagePercent(500, 0)).toBeNull();
    expect(usagePercent(500, null)).toBeNull();
  });
});

describe("buildBudgetLimitTree", () => {
  const companyLimit = limit({ level: "nest", ref: "company", amountCents: 50000, mode: "soft" });
  const projectLimit = limit({ level: "nest", ref: PROJECT_ID });
  const archivedProjectLimit = limit({ level: "nest", ref: OTHER_PROJECT_ID, amountCents: 700 });
  const casteLimit = limit({ level: "caste", ref: "designer" });
  const issueLimit = limit({ level: "issue", ref: ISSUE_ID });
  const limits = [companyLimit, projectLimit, archivedProjectLimit, casteLimit, issueLimit];

  const tree = buildBudgetLimitTree({
    limits,
    usage: [usage(companyLimit, 60000, true), usage(projectLimit, 250, false), usage(casteLimit, 0, false)],
    projects: [{ id: PROJECT_ID, name: "Board" }],
  });

  it("renders the company row first, then a row per project of the company", () => {
    expect(tree.nest.map((row) => row.ref)).toEqual(["company", PROJECT_ID, OTHER_PROJECT_ID]);
    expect(tree.nest[0].fixedRefLabelKey).toBe("budgetLimits.refCompany");
    expect(tree.nest[1].refLabel).toBe("Board");
    expect(tree.nest[1].depth).toBe(1);
  });

  it("keeps a limit whose project is not in the directory — history must not vanish", () => {
    const orphan = tree.nest.find((row) => row.ref === OTHER_PROJECT_ID);
    expect(orphan?.limit?.amountCents).toBe(700);
    expect(orphan?.refLabel).toBeNull();
  });

  it("carries the spend and the over-limit flag of every stored row", () => {
    expect(tree.nest[0].spentCents).toBe(60000);
    expect(tree.nest[0].overLimit).toBe(true);
    expect(tree.nest[1].spentCents).toBe(250);
    expect(tree.nest[1].overLimit).toBe(false);
  });

  it("reads a stored row without a usage row as zero spend, not as no limit", () => {
    const project = tree.nest[1];
    const noUsageTree = buildBudgetLimitTree({ limits: [projectLimit], usage: [], projects: [] });
    expect(noUsageTree.nest[1].limit).not.toBeNull();
    expect(noUsageTree.nest[1].spentCents).toBe(0);
    expect(project.limit).not.toBeNull();
  });

  it("always shows the single foraging row, and lists caste and task rows sorted", () => {
    expect(tree.foraging.map((row) => row.ref)).toEqual(["foraging"]);
    expect(tree.foraging[0].fixedRefLabelKey).toBe("budgetLimits.refForaging");
    expect(tree.caste.map((row) => row.ref)).toEqual(["designer"]);
    expect(tree.issue.map((row) => row.ref)).toEqual([ISSUE_ID]);

    const manyCastes = buildBudgetLimitTree({
      limits: [limit({ level: "caste", ref: "engineer" }), limit({ level: "caste", ref: "analyst" })],
      usage: [],
      projects: [],
    });
    expect(manyCastes.caste.map((row) => row.ref)).toEqual(["analyst", "engineer"]);
  });

  it("shows a ref the owner just added with no limit, so its amount can be typed first", () => {
    const added = buildBudgetLimitTree({
      limits: [],
      usage: [],
      projects: [],
      extraRefs: [{ level: "caste", ref: "engineer" }],
    });
    expect(added.caste).toHaveLength(1);
    expect(added.caste[0].limit).toBeNull();
    expect(added.caste[0].spentCents).toBeNull();
    expect(added.caste[0].key).toBe("caste:engineer");
  });

  it("does not duplicate a row that exists both as a limit and as a fresh ref", () => {
    const merged = buildBudgetLimitTree({
      limits: [casteLimit],
      usage: [],
      projects: [],
      extraRefs: [{ level: "caste", ref: "designer" }],
    });
    expect(merged.caste).toHaveLength(1);
    expect(merged.caste[0].limit).not.toBeNull();
  });

  it("flattens to the render order: nest, caste, foraging, task", () => {
    expect(flattenBudgetLimitTree(tree).map((row) => row.key)).toEqual([
      budgetLimitKey("nest", "company"),
      budgetLimitKey("nest", PROJECT_ID),
      budgetLimitKey("nest", OTHER_PROJECT_ID),
      budgetLimitKey("caste", "designer"),
      budgetLimitKey("foraging", "foraging"),
      budgetLimitKey("issue", ISSUE_ID),
    ]);
  });
});

describe("label keys", () => {
  it("points every label at the fork catalog key", () => {
    expect(levelLabelKey("nest")).toBe("budgetLimits.level.nest");
    expect(periodLabelKey("lifetime")).toBe("budgetLimits.period.lifetime");
    expect(modeLabelKey("soft")).toBe("budgetLimits.mode.soft");
    expect(signalOnlySourceLabelKey("env")).toBe("budgetLimits.source.env");
  });

  it("prefers a directory name, then a fixed-ref key, then the raw ref", () => {
    const [companyRow, projectRow] = buildBudgetLimitTree({
      limits: [limit({ level: "nest", ref: "company" })],
      usage: [],
      projects: [{ id: PROJECT_ID, name: "Board" }],
    }).nest;
    expect(nodeRefText(companyRow)).toEqual({ key: "budgetLimits.refCompany" });
    expect(nodeRefText(projectRow)).toEqual({ text: "Board" });
    expect(nodeRefText({ ...projectRow, refLabel: null, fixedRefLabelKey: null, ref: ISSUE_ID })).toEqual({
      text: ISSUE_ID,
    });
  });
});