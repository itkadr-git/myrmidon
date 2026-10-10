// @vitest-environment jsdom
//
// myrmidon(SETTINGS-UI A): the "Workspace hygiene" settings panel — the quota
// draft parse (empty means "the cap is off", a typo cannot save), the save
// path, the per-key source label and the last-sweep status. Neutral data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceHygieneSettingsPanelView,
  parseWorkspaceHygieneDraft,
} from "./WorkspaceHygieneSettingsPanel";
import type { WorkspaceHygieneSettingsView } from "./workspaceHygieneSettingsApi";

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

const VIEW: WorkspaceHygieneSettingsView = {
  quota: {
    workspaceQuotaMb: 2048,
    totalQuotaMb: null,
    sources: { workspaceQuotaMb: "settings", totalQuotaMb: "default" },
  },
  workspaces: [
    {
      id: "ws-1",
      name: "ws-alpha",
      status: "active",
      sizeBytes: 3 * 1024 * 1024,
      sizeMb: 3,
      measuredAt: "2026-10-08T00:00:00.000Z",
      overQuota: false,
      truncated: false,
    },
  ],
  status: {
    measuredWorkspaces: 1,
    overQuotaCount: 0,
    totalSizeMb: 3,
    lastSweepAt: "2026-10-08T00:00:00.000Z",
    lastSweep: null,
  },
};

function renderView(overrides: Partial<Parameters<typeof WorkspaceHygieneSettingsPanelView>[0]> = {}) {
  const onSave = vi.fn();
  const props = { view: VIEW, onSave, pending: false, error: null, ...overrides };
  act(() => {
    root.render(<WorkspaceHygieneSettingsPanelView {...props} />);
  });
  return { onSave };
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

function save() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save workspace hygiene quotas"),
  )!;
  act(() => button.click());
}

describe("parseWorkspaceHygieneDraft", () => {
  it("treats an empty field as the cap being off", () => {
    const { patch, errors } = parseWorkspaceHygieneDraft({
      workspaceQuotaMb: "",
      totalQuotaMb: "",
    });
    expect(errors).toEqual({});
    expect(patch).toEqual({ workspaceQuotaMb: null, totalQuotaMb: null });
  });

  it("refuses a non-integer or a zero quota", () => {
    const { patch, errors } = parseWorkspaceHygieneDraft({
      workspaceQuotaMb: "1.5",
      totalQuotaMb: "0",
    });
    expect(patch).toBeNull();
    expect(errors.workspaceQuotaMb).toBeTruthy();
    expect(errors.totalQuotaMb).toBeTruthy();
  });

  it("keeps a whole positive number", () => {
    const { patch } = parseWorkspaceHygieneDraft({
      workspaceQuotaMb: "2048",
      totalQuotaMb: "10240",
    });
    expect(patch).toEqual({ workspaceQuotaMb: 2048, totalQuotaMb: 10240 });
  });
});

describe("WorkspaceHygieneSettingsPanelView", () => {
  it("renders the stored quotas and the per-key source of each value", () => {
    renderView();
    expect(input("workspace-hygiene-workspaceQuotaMb").value).toBe("2048");
    expect(input("workspace-hygiene-totalQuotaMb").value).toBe("");
    expect(
      container.querySelector("[data-testid='workspace-hygiene-source-workspaceQuotaMb']")!
        .textContent,
    ).toBe("Saved here");
    expect(
      container.querySelector("[data-testid='workspace-hygiene-source-totalQuotaMb']")!.textContent,
    ).toBe("Default");
  });

  it("saves the edited quotas through the patch shape the API takes", () => {
    const { onSave } = renderView();
    setText("workspace-hygiene-totalQuotaMb", "4096");
    save();
    expect(onSave).toHaveBeenCalledWith({
      workspaceQuotaMb: 2048,
      totalQuotaMb: 4096,
    });
  });

  it("refuses to save a typo and shows the field error", () => {
    const { onSave } = renderView();
    setText("workspace-hygiene-workspaceQuotaMb", "many");
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='workspace-hygiene-error-workspaceQuotaMb']")!.textContent,
    ).toBeTruthy();
  });

  it("reports the last sweep: measured workspaces, over quota, total size", () => {
    renderView();
    expect(container.querySelector("[data-testid='workspace-hygiene-measured']")!.textContent).toBe(
      "1",
    );
    expect(container.querySelector("[data-testid='workspace-hygiene-over-quota']")!.textContent).toBe(
      "0",
    );
    expect(container.querySelector("[data-testid='workspace-hygiene-total-mb']")!.textContent).toBe(
      "3 MB",
    );
    const row = container.querySelector("[data-testid='workspace-hygiene-workspace-row']")!;
    expect(row.textContent).toContain("ws-alpha");
    expect(row.textContent).toContain("3 MB");
  });
});
