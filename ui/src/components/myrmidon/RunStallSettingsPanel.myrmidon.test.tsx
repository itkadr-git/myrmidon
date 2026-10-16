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
  it("shows the interval and page size as editable fields with their source", () => {
    render(view);
    expect(field("checkIntervalSec").value).toBe("60");
    expect(field("pageSize").value).toBe("50");
    expect(container.querySelector("[data-testid=run-stall-source-pageSize]")?.textContent).toBe("Default");
  });

  it("shows enabled and the threshold read-only, with a link to the team-liveness settings", () => {
    render(view);
    expect(field("thresholdSec")).toBeNull();
    expect(container.querySelector("[data-testid=run-stall-enabled]")).toBeNull();
    expect(container.querySelector("[data-testid=run-stall-enabled-value]")?.textContent).toBe("on");
    expect(container.querySelector("[data-testid=run-stall-threshold-value]")?.textContent).toBe("1200 s");
    expect(container.querySelector("[data-testid=run-stall-source-thresholdSec]")?.textContent).toBe(
      "From the server environment",
    );
    const link = container.querySelector("[data-testid=run-stall-team-liveness-link]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#team-liveness-settings");
  });

  it("saves only the interval and the page size", () => {
    const onSave = render(view);
    type("checkIntervalSec", "30");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({ checkIntervalSec: 30, pageSize: 50 });
  });

  it("blocks saving a value that is not a positive whole number", () => {
    const onSave = render(view);
    type("pageSize", "1.5");
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelector("[data-testid=run-stall-error-pageSize]")?.textContent).toContain("whole number");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the draft parser builds a patch of the two editable keys only", () => {
    const parsed = parseRunStallDraft({ checkIntervalSec: "15", pageSize: "200" });
    expect(parsed.errors).toEqual({});
    expect(parsed.patch).toEqual({ checkIntervalSec: 15, pageSize: 200 });
    expect(parseRunStallDraft({ checkIntervalSec: "", pageSize: "200" }).patch).toBeNull();
  });
});
