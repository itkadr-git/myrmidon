// @vitest-environment jsdom
//
// myrmidon(RUN-STALL-SETTINGS, 1.6.5): the Run stall detection
// section of Instance → General.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStallKey, RunStallSource } from "@paperclipai/shared";
import type { RunStallView } from "./runStallApi";
import { RunStallSettingsPanelView, parseRunStallDraft } from "./RunStallSettingsPanel";

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

const view: RunStallView = {
  settings: { enabled: true, thresholdSec: 1200, checkIntervalSec: 60, pageSize: 50 },
  sources: {
    enabled: "default",
    thresholdSec: "env",
    checkIntervalSec: "default",
    pageSize: "default",
  } as Record<RunStallKey, RunStallSource>,
};

function render(value: RunStallView | null, onSave = vi.fn(), pending = false, error: string | null = null) {
  flushSync(() => {
    root.render(<RunStallSettingsPanelView view={value} onSave={onSave} pending={pending} error={error} />);
  });
  return onSave;
}

function field(key: string): HTMLInputElement {
  return container.querySelector(`#run-stall-${key}`) as HTMLInputElement;
}

function type(key: string, text: string) {
  const input = field(key);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save run stall detection"))!;
}

describe("myrmidon(RUN-STALL-SETTINGS) run stall panel", () => {
  it("shows the effective values with where each one came from", () => {
    render(view);
    expect(field("thresholdSec").value).toBe("1200");
    expect(field("checkIntervalSec").value).toBe("60");
    expect(field("pageSize").value).toBe("50");
    expect(container.querySelector("[data-testid=run-stall-source-thresholdSec]")?.textContent).toBe(
      "From the server environment",
    );
    expect(container.querySelector("[data-testid=run-stall-source-pageSize]")?.textContent).toBe("Default");
  });

  it("saves all four values", () => {
    const onSave = render(view);
    type("thresholdSec", "300");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({ enabled: true, thresholdSec: 300, checkIntervalSec: 60, pageSize: 50 });
  });

  it("blocks saving a value that is not a positive whole number", () => {
    const onSave = render(view);
    type("thresholdSec", "1.5");
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelector("[data-testid=run-stall-error-thresholdSec]")?.textContent).toContain(
      "whole number",
    );
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the draft parser mirrors the server bounds shape: a patch of all four keys", () => {
    const parsed = parseRunStallDraft({ thresholdSec: "60", checkIntervalSec: "15", pageSize: "200" }, false);
    expect(parsed.errors).toEqual({});
    expect(parsed.patch).toEqual({ enabled: false, thresholdSec: 60, checkIntervalSec: 15, pageSize: 200 });
    expect(parseRunStallDraft({ thresholdSec: "", checkIntervalSec: "15", pageSize: "200" }, true).patch).toBeNull();
  });
});
