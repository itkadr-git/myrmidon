// @vitest-environment jsdom
//
// myrmidon(1.6.1-FORAGING-LIMITS-UI): the "Learning (foraging)" settings
// panel — the draft parse (a typo cannot save, an empty cents field means no
// limit) and the save path. Neutral data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForagingSettingsPanelView, parseForagingDraft } from "./ForagingSettingsPanel";
import type { ForagingSettingsView } from "./foragingSettingsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const VIEW: ForagingSettingsView = {
  settings: {
    enabled: true,
    intervalSec: 3600,
    minHostIntervalSec: 60,
    passBudgetCents: 50,
    dailyBudgetCents: null,
    monthlyBudgetCents: null,
    roleBudgetCents: null,
    agentBudgetCents: null,
    enforcement: "hard",
    autoOffCostPerTaskCents: null,
  },
  sources: {
    enabled: "settings",
    intervalSec: "default",
    minHostIntervalSec: "default",
    passBudgetCents: "settings",
    dailyBudgetCents: "default",
    monthlyBudgetCents: "default",
    roleBudgetCents: "default",
    agentBudgetCents: "default",
    enforcement: "default",
    autoOffCostPerTaskCents: "default",
  },
};

function renderView(overrides: Partial<Parameters<typeof ForagingSettingsPanelView>[0]> = {}) {
  const onSave = vi.fn();
  const props = { view: VIEW, onSave, pending: false, error: null, ...overrides };
  act(() => {
    root.render(<ForagingSettingsPanelView {...props} />);
  });
  return { onSave, props };
}

function input(id: string) {
  return container.querySelector<HTMLInputElement>(`#${id}`)!;
}

function setText(id: string, value: string) {
  const el = input(id);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function toggle(testId: string) {
  const el = container.querySelector(`[data-testid="${testId}"]`) as unknown as { click(): void };
  act(() => el.click());
}

function save() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save learning settings"),
  )!;
  act(() => button.click());
}

const DRAFT = {
  intervalSec: "3600",
  minHostIntervalSec: "60",
  passBudgetCents: "",
  dailyBudgetCents: "",
  monthlyBudgetCents: "",
  roleBudgetCents: "",
  agentBudgetCents: "",
  autoOffCostPerTaskCents: "",
};

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) parseForagingDraft", () => {
  it("accepts the full valid draft and maps empty cents to null", () => {
    const { patch, errors } = parseForagingDraft({ ...DRAFT });
    expect(errors).toEqual({});
    expect(patch).toMatchObject({ intervalSec: 3600, minHostIntervalSec: 60, dailyBudgetCents: null });
  });

  it("refuses a non-integer interval", () => {
    const { patch, errors } = parseForagingDraft({ ...DRAFT, intervalSec: "3600.5" });
    expect(patch).toBeNull();
    expect(errors.intervalSec).toMatch(/whole number/);
  });

  it("refuses an interval under the floor", () => {
    const { patch, errors } = parseForagingDraft({ ...DRAFT, intervalSec: "30" });
    expect(patch).toBeNull();
    expect(errors.intervalSec).toMatch(/60/);
  });

  it("refuses a zero cents limit", () => {
    const { patch, errors } = parseForagingDraft({ ...DRAFT, dailyBudgetCents: "0" });
    expect(patch).toBeNull();
    expect(errors.dailyBudgetCents).toMatch(/greater than zero/);
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) settings panel", () => {
  it("renders every field with its origin", () => {
    renderView();
    expect(container.querySelector("[data-testid=foraging-source-enabled]")?.textContent).toContain(
      "Saved here",
    );
    expect(container.querySelector("[data-testid=foraging-source-intervalSec]")?.textContent).toContain(
      "Default",
    );
    expect(input("foraging-dailyBudgetCents").value).toBe("");
  });

  it("saves the draft with the daily limit and the mode", () => {
    const { onSave } = renderView();
    setText("foraging-dailyBudgetCents", "100");
    toggle("foraging-soft-toggle");
    save();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ dailyBudgetCents: 100, enforcement: "soft", enabled: true }),
    );
  });

  it("keeps the save button off for an invalid draft", () => {
    const { onSave } = renderView();
    setText("foraging-dailyBudgetCents", "-5");
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid=foraging-error-dailyBudgetCents]")?.textContent,
    ).toMatch(/greater than zero/);
  });

  it("shows the error line when the save failed", () => {
    renderView({ error: "Saving the learning settings failed." });
    expect(container.textContent).toContain("Saving the learning settings failed.");
  });
});
