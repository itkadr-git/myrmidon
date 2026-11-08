// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ToolPolicyCacheSettingsPanelView,
  parseToolPolicyCacheDraft,
} from "./ToolPolicyCacheSettingsPanel";
import type { ToolPolicyCacheView } from "./toolPolicyCacheApi";

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

const VIEW: ToolPolicyCacheView = {
  settings: { ttlMs: 10_000 },
  effective: {
    ttlMs: 10_000,
    cacheEnabled: true,
    defaultTtlMs: 30_000,
    minTtlMs: 0,
    maxTtlMs: 300_000,
    cachedCompanies: 1,
    loads: 3,
    hits: 40,
    misses: 3,
  },
};

function renderView(overrides: Partial<Parameters<typeof ToolPolicyCacheSettingsPanelView>[0]> = {}) {
  const onSave = vi.fn();
  const props = { view: VIEW, onSave, pending: false, error: null, ...overrides };
  act(() => {
    root.render(<ToolPolicyCacheSettingsPanelView {...props} />);
  });
  return { onSave };
}

const saveButton = () =>
  container.querySelector<HTMLButtonElement>("[data-testid='tool-policy-cache-save']")!;
const defaultButton = () =>
  container.querySelector<HTMLButtonElement>("[data-testid='tool-policy-cache-default']")!;

function setTtl(value: string) {
  const el = container.querySelector<HTMLInputElement>("#tool-policy-cache-ttl")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("tool policy cache settings panel", () => {
  it("shows the lifetime in seconds and starts with nothing to save", () => {
    renderView();
    expect(container.querySelector<HTMLInputElement>("#tool-policy-cache-ttl")?.value).toBe("10");
    expect(container.querySelector("[data-testid='tool-policy-cache-current']")?.textContent).toBe("now 10 s");
    expect(container.querySelector("[data-testid='tool-policy-cache-counters']")?.textContent).toContain("40 hits");
    expect(saveButton().disabled).toBe(true);
  });

  it("sends the typed seconds as milliseconds", () => {
    const { onSave } = renderView();
    setTtl("45");
    act(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ ttlMs: 45_000 });
  });

  it("accepts 0 as the switch-off value", () => {
    const { onSave } = renderView();
    setTtl("0");
    act(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ ttlMs: 0 });
  });

  it("refuses a value outside the range and never sends it", () => {
    const { onSave } = renderView();
    setTtl("301");
    expect(container.querySelector("[data-testid='tool-policy-cache-error']")?.textContent).toContain("0 to 300");
    expect(saveButton().disabled).toBe(true);
    act(() => saveButton().click());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("returns to the default with a null patch, only when a value is stored", () => {
    const { onSave } = renderView();
    act(() => defaultButton().click());
    expect(onSave).toHaveBeenCalledWith({ ttlMs: null });
  });

  it("disables the default button when nothing is stored", () => {
    renderView({ view: { ...VIEW, settings: {} } });
    expect(defaultButton().disabled).toBe(true);
  });

  it("parses the draft", () => {
    expect(parseToolPolicyCacheDraft("12", 300_000)).toEqual({ patch: { ttlMs: 12_000 }, error: null });
    expect(parseToolPolicyCacheDraft("1.5", 300_000).patch).toBeNull();
    expect(parseToolPolicyCacheDraft("", 300_000).patch).toBeNull();
    expect(parseToolPolicyCacheDraft("-1", 300_000).patch).toBeNull();
  });
});
