// @vitest-environment jsdom
//
// myrmidon(1.7-BUDGET-CONFIG-B): the Budget enforcement section of
// Instance → General — the mode picker, the source line, and the dirty gate
// on the Save button.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetEnforcementView } from "./budgetEnforcementApi";
import { BudgetEnforcementSettingsPanelView } from "./BudgetEnforcementSettingsPanel";

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
  flushSync(() => root.unmount());
  container.remove();
});

const view: BudgetEnforcementView = { mode: "signal_only", source: "default" };

function render(value: BudgetEnforcementView | null, onSave = vi.fn(), pending = false, error: string | null = null) {
  flushSync(() => {
    root.render(<BudgetEnforcementSettingsPanelView view={value} onSave={onSave} pending={pending} error={error} />);
  });
  return onSave;
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save enforcement mode"))!;
}

function modeButton(title: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(title))!;
}

describe("BudgetEnforcementSettingsPanelView", () => {
  it("renders the three modes with the effective one selected and the source shown", () => {
    render({ mode: "soft", source: "settings" });
    expect(modeButton("Soft: pause and ask").getAttribute("aria-checked")).toBe("true");
    expect(modeButton("Signal only").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("[data-testid='budget-enforcement-source']")?.textContent).toBe("Saved here");
    // Nothing changed yet: Save stays disabled.
    expect(saveButton().disabled).toBe(true);
  });

  it("enables Save only after a different mode is picked, and saves the pick", () => {
    const onSave = vi.fn();
    render(view, onSave);
    expect(saveButton().disabled).toBe(true);

    flushSync(() => {
      modeButton("Hard: refuse").click();
    });
    expect(saveButton().disabled).toBe(false);

    flushSync(() => {
      saveButton().click();
    });
    expect(onSave).toHaveBeenCalledWith({ mode: "hard" });
  });

  it("marks the environment override as forced, and shows the load placeholder without a view", () => {
    render({ mode: "hard", source: "env" });
    expect(container.querySelector("[data-testid='budget-enforcement-source']")?.textContent).toBe(
      "Forced by the server environment",
    );

    flushSync(() => {
      root.render(<BudgetEnforcementSettingsPanelView view={null} onSave={vi.fn()} pending={false} error={null} />);
    });
    expect(container.textContent).toContain("Loading the budget enforcement mode");
  });

  it("shows an error line and keeps the picker usable", () => {
    render(view, vi.fn(), false, "Saving the budget enforcement mode failed.");
    expect(container.textContent).toContain("Saving the budget enforcement mode failed.");
    expect(modeButton("Signal only")).toBeTruthy();
  });
});
