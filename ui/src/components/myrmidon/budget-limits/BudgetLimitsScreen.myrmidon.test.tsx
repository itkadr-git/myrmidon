// @vitest-environment jsdom
//
// myrmidon(1.7 BUDGET-CONFIG D): view-tier tests of the "Budgets" screen — the
// hierarchy rows with their spend, in-place editing, the "signal only" switch
// with its source and the change journal. The view is rendered directly (no
// react-query), so every assertion is about what the owner sees and what the
// screen hands back to the wire tier.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { BudgetLimitsScreenView } from "./BudgetLimitsScreen";
import type {
  BudgetLimitChangeView,
  BudgetLimitLevel,
  BudgetLimitUpsertBody,
  BudgetLimitUsageRow,
  BudgetLimitView,
  BudgetLimitsSignalOnlyView,
} from "./budgetLimitsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const ISSUE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

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
  return { ...row, spentCents, events: 2, overLimit };
}

interface Handlers {
  onSaveLimit: Mock<(level: BudgetLimitLevel, ref: string, body: BudgetLimitUpsertBody) => void>;
  onDeleteLimit: Mock<(level: BudgetLimitLevel, ref: string) => void>;
  onToggleSignalOnly: Mock<(signalOnly: boolean) => void>;
}

function render(options: {
  limits?: BudgetLimitView[] | null;
  usage?: BudgetLimitUsageRow[];
  journal?: BudgetLimitChangeView[];
  signalOnly?: BudgetLimitsSignalOnlyView | null;
}): Handlers {
  const onSaveLimit = vi.fn<(level: BudgetLimitLevel, ref: string, body: BudgetLimitUpsertBody) => void>();
  const onDeleteLimit = vi.fn<(level: BudgetLimitLevel, ref: string) => void>();
  const onToggleSignalOnly = vi.fn<(signalOnly: boolean) => void>();
  flushSync(() => {
    root.render(
      <BudgetLimitsScreenView
        limits={options.limits}
        usage={options.usage ?? []}
        journal={options.journal ?? []}
        signalOnly={options.signalOnly === undefined ? { signalOnly: true, source: "default" } : options.signalOnly}
        projects={[{ id: PROJECT_ID, name: "Board" }]}
        onSaveLimit={onSaveLimit}
        onDeleteLimit={onDeleteLimit}
        onToggleSignalOnly={onToggleSignalOnly}
        pending={false}
        error={null}
      />,
    );
  });
  return { onSaveLimit, onDeleteLimit, onToggleSignalOnly };
}

function row(key: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid="budget-limits-row-${key}"]`)!;
}

function byTestId<T extends HTMLElement>(testId: string): T {
  return container.querySelector<T>(`[data-testid="${testId}"]`)!;
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const COMPANY = limit({ level: "nest", ref: "company", amountCents: 50000, mode: "soft" });
const PROJECT = limit({ level: "nest", ref: PROJECT_ID });
const CASTE = limit({ level: "caste", ref: "designer" });
const ISSUE = limit({ level: "issue", ref: ISSUE_ID });

describe("BudgetLimitsScreenView — the limit tree", () => {
  it("renders the hierarchy with the spend against each limit", () => {
    render({
      limits: [COMPANY, PROJECT, CASTE, ISSUE],
      usage: [usage(COMPANY, 60000, true), usage(PROJECT, 250)],
    });

    expect(container.querySelectorAll("[data-testid^='budget-limits-row-']")).toHaveLength(5);
    expect(row("nest:company").textContent).toContain("Whole company");
    expect(row(`nest:${PROJECT_ID}`).textContent).toContain("Board");
    expect(row("caste:designer").textContent).toContain("Caste");
    expect(row("foraging:foraging").textContent).toContain("Foraging pass");
    expect(row(`issue:${ISSUE_ID}`).textContent).toContain(ISSUE_ID);

    const companySpend = byTestId("budget-limits-spent-nest:company").textContent ?? "";
    expect(companySpend).toContain("$600.00");
    expect(companySpend).toContain("$500.00");
    expect(companySpend).toContain("Over the limit");
    expect(byTestId(`budget-limits-spent-nest:${PROJECT_ID}`).textContent).toContain("$2.50");
  });

  it("leaves the amount dressed with the stored value, period and mode", () => {
    render({ limits: [COMPANY] });
    expect(byTestId<HTMLInputElement>("budget-limits-amount-nest:company").value).toBe("500.00");
    expect(byTestId<HTMLSelectElement>("budget-limits-period-nest:company").value).toBe("calendar_month_utc");
    expect(byTestId<HTMLSelectElement>("budget-limits-mode-nest:company").value).toBe("soft");
  });

  it("shows a row without a limit — the owner sets one where none exists", () => {
    render({ limits: [COMPANY] });
    expect(row("foraging:foraging").textContent).toContain("No limit");
    expect(byTestId<HTMLInputElement>("budget-limits-amount-foraging:foraging").value).toBe("");
    expect(row(`nest:${PROJECT_ID}`).textContent).toContain("No limit");
  });

  it("shows the loading placeholder while the limits are still coming", () => {
    render({ limits: undefined });
    expect(byTestId("myrmidon-budget-limits-loading")).not.toBeNull();
    expect(container.querySelector("[data-testid='budget-limits-tree']")).toBeNull();
  });
});

describe("BudgetLimitsScreenView — in-place editing", () => {
  it("saves an edited amount for the row's level and ref", () => {
    const { onSaveLimit } = render({ limits: [COMPANY] });
    setInput(byTestId<HTMLInputElement>("budget-limits-amount-nest:company"), "750");
    setSelect(byTestId<HTMLSelectElement>("budget-limits-mode-nest:company"), "hard");
    flushSync(() => byTestId<HTMLButtonElement>("budget-limits-save-nest:company").click());

    expect(onSaveLimit).toHaveBeenCalledWith("nest", "company", {
      amountCents: 75000,
      period: "calendar_month_utc",
      mode: "hard",
      isActive: true,
    });
  });

  it("creates the limit of a row that has none", () => {
    const { onSaveLimit } = render({ limits: [] });
    setInput(byTestId<HTMLInputElement>("budget-limits-amount-foraging:foraging"), "25");
    flushSync(() => byTestId<HTMLButtonElement>("budget-limits-save-foraging:foraging").click());

    expect(onSaveLimit).toHaveBeenCalledWith("foraging", "foraging", {
      amountCents: 2500,
      period: "calendar_month_utc",
      mode: "hard",
      isActive: true,
    });
  });

  it("refuses an invalid amount: the rule is named, the save stays blocked and nothing is sent", () => {
    const { onSaveLimit } = render({ limits: [COMPANY] });
    setInput(byTestId<HTMLInputElement>("budget-limits-amount-nest:company"), "12,5,0");

    const save = byTestId<HTMLButtonElement>("budget-limits-save-nest:company");
    expect(save.disabled).toBe(true);
    expect(row("nest:company").textContent).toContain("Enter a number, for example 25 or 25.50.");

    flushSync(() => save.click());
    expect(onSaveLimit).not.toHaveBeenCalled();
  });

  it("removes a stored limit and never offers removal on a row without one", () => {
    const { onDeleteLimit } = render({ limits: [COMPANY] });
    flushSync(() => byTestId<HTMLButtonElement>("budget-limits-remove-nest:company").click());
    expect(onDeleteLimit).toHaveBeenCalledWith("nest", "company");
    expect(container.querySelector("[data-testid='budget-limits-remove-foraging:foraging']")).toBeNull();
  });

  it("adds a limit for a new caste ref and refuses a malformed one", () => {
    const { onSaveLimit } = render({ limits: [] });
    flushSync(() => byTestId<HTMLButtonElement>("budget-limits-add-caste").click());

    const refInput = byTestId<HTMLInputElement>("budget-limits-add-ref");
    setInput(refInput, "Engineer");
    flushSync(() => byTestId<HTMLButtonElement>("budget-limits-add-submit").click());
    expect(container.querySelector("[data-testid='budget-limits-row-caste:engineer']")).toBeNull();
    expect(byTestId("budget-limits-add-form").textContent).toContain(
      "A caste value holds lowercase letters, digits and hyphens.",
    );

    setInput(refInput, "engineer");
    flushSync(() => byTestId<HTMLButtonElement>("budget-limits-add-submit").click());
    expect(row("caste:engineer").textContent).toContain("No limit");

    setInput(byTestId<HTMLInputElement>("budget-limits-amount-caste:engineer"), "40");
    flushSync(() => byTestId<HTMLButtonElement>("budget-limits-save-caste:engineer").click());
    expect(onSaveLimit).toHaveBeenCalledWith("caste", "engineer", {
      amountCents: 4000,
      period: "calendar_month_utc",
      mode: "hard",
      isActive: true,
    });
  });
});

describe("BudgetLimitsScreenView — signal only and the journal", () => {
  it("reflects the effective signal-only value, its source and the owner's switch", () => {
    const { onToggleSignalOnly } = render({ limits: [COMPANY], signalOnly: { signalOnly: true, source: "stored" } });
    const toggle = byTestId<HTMLButtonElement>("budget-limits-signal-only");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("budget-limits-signal-only-source").textContent).toBe("Saved in the settings");

    flushSync(() => toggle.click());
    expect(onToggleSignalOnly).toHaveBeenCalledWith(false);
  });

  it("locks the switch when the environment forces the value", () => {
    render({ limits: [COMPANY], signalOnly: { signalOnly: false, source: "env" } });
    const toggle = byTestId<HTMLButtonElement>("budget-limits-signal-only");
    expect(toggle.disabled).toBe(true);
    expect(byTestId("budget-limits-signal-only-source").textContent).toContain("Forced by the server environment");
  });

  it("shows the change journal with who, what and the amount move", () => {
    const journal: BudgetLimitChangeView[] = [
      {
        id: "change-2",
        companyId: "company-1",
        limitId: "id-nest-company",
        action: "update",
        level: "nest",
        ref: "company",
        before: { amountCents: 50000 },
        after: { amountCents: 75000 },
        actorType: "user",
        actorId: "user-1",
        at: "2026-10-04T10:00:00.000Z",
      },
      {
        id: "change-1",
        companyId: "company-1",
        limitId: "id-caste-designer",
        action: "create",
        level: "caste",
        ref: "designer",
        before: null,
        after: { amountCents: 1000 },
        actorType: "user",
        actorId: "user-1",
        at: "2026-10-04T09:00:00.000Z",
      },
    ];
    render({ limits: [COMPANY], journal });

    const rows = container.querySelectorAll("[data-testid^='budget-limits-journal-change-']");
    expect(rows).toHaveLength(2);
    expect(byTestId("budget-limits-journal-change-2").textContent).toContain("Was $500.00, became $750.00");
    expect(byTestId("budget-limits-journal-change-1").textContent).toContain("Limit created: $10.00");
  });

  it("says so when nothing has changed yet", () => {
    render({ limits: [COMPANY], journal: [] });
    expect(byTestId("budget-limits-journal-empty").textContent).toBe("No changes yet");
  });
});