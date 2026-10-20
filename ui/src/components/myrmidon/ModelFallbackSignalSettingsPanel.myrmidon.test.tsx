// @vitest-environment jsdom
//
// myrmidon(SETTINGS-UI A): the "Model fallback signal" panel — the draft parse
// against the shared bounds (an out-of-window or fractional number cannot
// save; an empty field keeps the value in force), the save path, the enabled
// switch and the per-key source labels. Neutral data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelFallbackSignalSettingsPanelView,
  parseFallbackSignalDraft,
} from "./ModelFallbackSignalSettingsPanel";
import type { ResolvedFallbackSignalSettingsView } from "./modelFallbackSignalSettingsApi";

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

const VIEW: ResolvedFallbackSignalSettingsView = {
  settings: { enabled: true, thresholdPct: 20, minCalls: 20, windowSec: 3600, intervalSec: 300 },
  sources: { enabled: "settings", thresholdPct: "env", minCalls: "default", windowSec: "default", intervalSec: "default" },
};

function renderView(
  overrides: Partial<Parameters<typeof ModelFallbackSignalSettingsPanelView>[0]> = {},
) {
  const onSave = vi.fn();
  act(() => {
    root.render(
      <ModelFallbackSignalSettingsPanelView
        view={VIEW}
        onSave={onSave}
        pending={false}
        error={null}
        {...overrides}
      />,
    );
  });
  return { onSave };
}

function setText(id: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(`#${id}`)!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function save() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save model fallback signal settings"),
  )!;
  act(() => button.click());
}

const DRAFT = { enabled: true, thresholdPct: "20", minCalls: "20", windowSec: "3600", intervalSec: "300" };

describe("parseFallbackSignalDraft", () => {
  it("carries the switch always and only the filled numbers", () => {
    const { patch } = parseFallbackSignalDraft({ ...DRAFT, minCalls: "", windowSec: "" });
    expect(patch).toEqual({ enabled: true, thresholdPct: 20, intervalSec: 300 });
  });

  it("refuses numbers outside the shared bounds", () => {
    const above = parseFallbackSignalDraft({ ...DRAFT, thresholdPct: "101" });
    expect(above.patch).toBeNull();
    expect(above.errors.thresholdPct).toBeTruthy();

    const below = parseFallbackSignalDraft({ ...DRAFT, windowSec: "299" });
    expect(below.patch).toBeNull();
    expect(below.errors.windowSec).toBeTruthy();
  });

  it("refuses a fraction or a non-number", () => {
    const { patch, errors } = parseFallbackSignalDraft({
      ...DRAFT,
      minCalls: "1.5",
      intervalSec: "soon",
    });
    expect(patch).toBeNull();
    expect(errors.minCalls).toBeTruthy();
    expect(errors.intervalSec).toBeTruthy();
  });
});

describe("ModelFallbackSignalSettingsPanelView", () => {
  it("renders the effective settings and the per-key source", () => {
    renderView();
    expect(
      container.querySelector<HTMLInputElement>("#model-fallback-thresholdPct")!.value,
    ).toBe("20");
    expect(
      container.querySelector("[data-testid='model-fallback-source-enabled']")!.textContent,
    ).toBe("Saved here");
    expect(
      container.querySelector("[data-testid='model-fallback-source-thresholdPct']")!.textContent,
    ).toBe("Environment override");
    expect(
      container.querySelector("[data-testid='model-fallback-source-windowSec']")!.textContent,
    ).toBe("Default");
  });

  it("saves the edited threshold through the API patch shape", () => {
    const { onSave } = renderView();
    setText("model-fallback-thresholdPct", "35");
    save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ thresholdPct: 35 }));
  });

  it("flips the master switch and carries it in the patch", () => {
    const { onSave } = renderView();
    const toggle = container.querySelector(
      "[data-testid='model-fallback-enabled-toggle']",
    ) as unknown as { click(): void };
    act(() => toggle.click());
    save();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("refuses to save an out-of-window value and names the field", () => {
    const { onSave } = renderView();
    setText("model-fallback-windowSec", "60");
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='model-fallback-error-windowSec']")!.textContent,
    ).toBeTruthy();
  });
});
