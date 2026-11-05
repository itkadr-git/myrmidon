// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunQueuePrioritySettingsPanelView, parseRunPriorityDraft, toRunPriorityDraft } from "./RunQueuePrioritySettingsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = {
  source: "settings" as const,
  settings: {
    issuePriorityWeights: { critical: 100, high: 80, medium: 60, low: 40, none: 20 },
    roleWeights: { review: 90, engineer: 50, custom: 37 },
    starvationLimitMinutes: 90,
    starvationTopWeight: 10_000,
  },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});
function render(canEdit = true, onSave = vi.fn()) {
  flushSync(() => root.render(<RunQueuePrioritySettingsPanelView view={view} pending={false} canEdit={canEdit} onSave={onSave} error={null} />));
  return onSave;
}
function input(id: string) { return container.querySelector<HTMLInputElement>(`#${id}`); }
function setInput(id: string, value: string) {
  const element = input(id);
  if (!element) throw new Error(`missing ${id}`);
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("run priority settings draft", () => {
  it("preserves custom roles and issue keys returned by GET in the PATCH", () => {
    const draft = toRunPriorityDraft(view.settings);
    draft.issuePriorityWeights.critical = "120";
    draft.starvationTopWeight = "15000";
    expect(parseRunPriorityDraft(draft)).toEqual({
      patch: { issuePriorityWeights: { ...view.settings.issuePriorityWeights, critical: 120 }, roleWeights: view.settings.roleWeights, starvationTopWeight: 15000 },
      errors: {},
    });
  });
  it("rejects missing, negative, fractional, and out-of-range weights", () => {
    const draft = toRunPriorityDraft(view.settings);
    draft.issuePriorityWeights.none = "";
    draft.roleWeights.custom = "-1";
    draft.starvationTopWeight = "1000001";
    const result = parseRunPriorityDraft(draft);
    expect(result.patch).toBeNull();
    expect(Object.keys(result.errors)).toEqual(expect.arrayContaining(["issue-none", "role-custom", "starvation"]));
    draft.starvationTopWeight = "0.5";
    expect(parseRunPriorityDraft(draft).errors.starvation).toBe("invalidWeight");
  });
});

describe("run priority panel", () => {
  it("renders all five issue priorities, custom roles, starvation, and source", () => {
    render();
    for (const key of ["critical", "high", "medium", "low", "none"]) expect(input(`run-priority-issue-${key}`)).toBeTruthy();
    expect(input("run-priority-role-custom")?.value).toBe("37");
    expect(input("run-priority-starvation-top")?.value).toBe("10000");
    expect(container.textContent).toContain("Saved here");
  });
  it("sends edited values and blocks malformed values", () => {
    const save = render();
    setInput("run-priority-issue-critical", "115");
    setInput("run-priority-starvation-top", "25000");
    flushSync(() => container.querySelector("button")?.click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ issuePriorityWeights: expect.objectContaining({ critical: 115 }), starvationTopWeight: 25000 }));
    setInput("run-priority-starvation-top", "-2");
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  });
  it("shows read-only values to a non-admin without a save control", () => {
    render(false);
    expect(input("run-priority-issue-critical")?.disabled).toBe(true);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Only instance administrators");
  });
});
