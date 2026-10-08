// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamLivenessSettingsPanelView, parseTeamLivenessDraft } from "./TeamLivenessSettingsPanel";
import type { TeamLivenessView } from "./teamLivenessApi";

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

const VIEW: TeamLivenessView = {
  settings: {
    autoResumeEnabled: true,
    runStallEnabled: true,
    runStallThresholdSec: 1200,
    idlePickupEnabled: true,
    idlePickupIntervalSec: 30,
    idlePickupWakeBudgetPerMin: 5,
    idlePickupWakeBatch: 5,
  },
  stored: {},
  sources: {
    autoResumeEnabled: "default",
    runStallEnabled: "env",
    runStallThresholdSec: "env",
    idlePickupEnabled: "settings",
    idlePickupIntervalSec: "default",
    idlePickupWakeBudgetPerMin: "settings",
    idlePickupWakeBatch: "settings",
  },
  defaults: {
    autoResumeEnabled: true,
    runStallEnabled: true,
    runStallThresholdSec: 1200,
    idlePickupEnabled: true,
    idlePickupIntervalSec: 30,
    idlePickupWakeBudgetPerMin: 5,
    idlePickupWakeBatch: 5,
  },
  bounds: {
    runStallThresholdSec: { min: 60, max: 86400, default: 1200 },
    idlePickupIntervalSec: { min: 5, max: Number.MAX_SAFE_INTEGER, default: 30 },
    idlePickupWakeBudgetPerMin: { min: 1, max: 60, default: 5 },
    idlePickupWakeBatch: { min: 1, max: 60, default: 5 },
  },
};

function renderView(overrides: Partial<Parameters<typeof TeamLivenessSettingsPanelView>[0]> = {}) {
  const onSave = vi.fn();
  const props = { view: VIEW, onSave, pending: false, error: null, ...overrides };
  act(() => {
    root.render(<TeamLivenessSettingsPanelView {...props} />);
  });
  return { onSave };
}

function saveButton() {
  return container.querySelector<HTMLButtonElement>("[data-testid='team-liveness-save']")!;
}

function setInput(key: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(`#team-liveness-${key}`)!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function toggle(key: string) {
  const el = container.querySelector<HTMLInputElement>(`#team-liveness-${key}`)!;
  act(() => {
    el.click();
  });
}

describe("team liveness settings panel", () => {
  it("shows the effective values and where each one comes from", () => {
    renderView();
    expect(container.textContent).toContain("Team liveness");
    expect(
      container.querySelector("[data-testid='team-liveness-source-idlePickupWakeBudgetPerMin']")?.textContent,
    ).toBe("Saved here");
    expect(
      container.querySelector("[data-testid='team-liveness-source-runStallThresholdSec']")?.textContent,
    ).toBe("From the server environment");
    expect(container.querySelector<HTMLInputElement>("#team-liveness-runStallThresholdSec")?.value).toBe(
      "1200",
    );
    // A field nobody touched cannot be saved: the button starts disabled.
    expect(saveButton().disabled).toBe(true);
  });

  it("sends only the keys the operator changed", () => {
    const { onSave } = renderView();

    toggle("idlePickupEnabled");
    setInput("idlePickupWakeBudgetPerMin", "2");
    act(() => saveButton().click());

    expect(onSave).toHaveBeenCalledTimes(1);
    // The environment-controlled threshold is not in the patch: saving must not
    // freeze an environment value into the settings row.
    expect(onSave.mock.calls[0]![0]).toEqual({
      idlePickupEnabled: false,
      idlePickupWakeBudgetPerMin: 2,
    });
  });

  it("refuses an invalid number and never sends a broken patch", () => {
    const { onSave } = renderView();

    setInput("idlePickupWakeBudgetPerMin", "0");
    expect(
      container.querySelector("[data-testid='team-liveness-error-idlePickupWakeBudgetPerMin']")?.textContent,
    ).toContain("greater than zero");
    expect(saveButton().disabled).toBe(true);

    setInput("idlePickupWakeBudgetPerMin", "3");
    expect(
      container.querySelector("[data-testid='team-liveness-error-idlePickupWakeBudgetPerMin']"),
    ).toBeNull();
    act(() => saveButton().click());
    expect(onSave.mock.calls[0]![0]).toEqual({ idlePickupWakeBudgetPerMin: 3 });
  });

  it("parses a draft into a patch of touched keys only", () => {
    expect(parseTeamLivenessDraft({ switches: {}, numbers: {} })).toEqual({ patch: {}, errors: {} });
    expect(
      parseTeamLivenessDraft({ switches: { autoResumeEnabled: false }, numbers: {} }).patch,
    ).toEqual({ autoResumeEnabled: false });
    expect(
      parseTeamLivenessDraft({ switches: {}, numbers: { runStallThresholdSec: " 900 " } }).patch,
    ).toEqual({ runStallThresholdSec: 900 });
    const broken = parseTeamLivenessDraft({ switches: {}, numbers: { runStallThresholdSec: "abc" } });
    expect(broken.patch).toBeNull();
    expect(broken.errors.runStallThresholdSec).toBeTruthy();
  });
});