// @vitest-environment jsdom
//
// myrmidon(C0) RUNTIME-LIMITS: the Run limits section of Instance → General.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunLimitKey, RunLimitsSource } from "@paperclipai/shared";
import type { RuntimeLimitsView } from "./runtimeLimitsApi";
import { RuntimeLimitsSettingsPanelView, parseRunLimitsDraft } from "./RuntimeLimitsSettingsPanel";

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

const view: RuntimeLimitsView = {
  limits: {
    maxConcurrentRuns: 6,
    maxStartsPerMinute: null,
    minFreeMemoryMb: 2048,
    runMemoryEstimateMb: 300,
    minFreeHostMemoryMb: 15360,
    maxHostLoadPercentPerCore: 90,
  },
  sources: {
    maxConcurrentRuns: "env",
    maxStartsPerMinute: "default",
    minFreeMemoryMb: "env",
    runMemoryEstimateMb: "default",
    minFreeHostMemoryMb: "default",
    maxHostLoadPercentPerCore: "default",
  } as Record<RunLimitKey, RunLimitsSource>,
  // myrmidon(1.6.5 rc.2): the live host reading the ceiling is applied to.
  hostLoad: {
    state: "open",
    thresholdPercent: 90,
    load1: 19.2,
    cores: 16,
    loadPercentPerCore: 120,
    backgroundPercentPerCore: 115,
    load15PercentPerCore: 115,
    loadAboveBackgroundPercent: 5,
    reason: null,
    heldSince: null,
  },
};

function render(value: RuntimeLimitsView | null, onSave = vi.fn(), pending = false, error: string | null = null) {
  flushSync(() => {
    root.render(<RuntimeLimitsSettingsPanelView view={value} onSave={onSave} pending={pending} error={error} />);
  });
  return onSave;
}

function field(key: RunLimitKey): HTMLInputElement {
  return container.querySelector(`#runtime-limit-${key}`) as HTMLInputElement;
}

function type(key: RunLimitKey, text: string) {
  const input = field(key);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save run limits"))!;
}

describe("myrmidon(C0) run limits panel", () => {
  it("shows the effective values with where each one came from", () => {
    render(view);
    expect(field("maxConcurrentRuns").value).toBe("6");
    // An unset cap is an empty field: the limit is off.
    expect(field("maxStartsPerMinute").value).toBe("");
    expect(field("minFreeMemoryMb").value).toBe("2048");
    expect(field("runMemoryEstimateMb").value).toBe("300");
    expect(container.querySelector("[data-testid=runtime-limit-source-maxConcurrentRuns]")?.textContent).toBe(
      "From the server environment",
    );
    expect(container.querySelector("[data-testid=runtime-limit-source-maxStartsPerMinute]")?.textContent).toBe(
      "Default",
    );
  });

  it("saves all the values, an empty field as 'no limit'", () => {
    const onSave = render(view);
    type("maxConcurrentRuns", "12");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      maxConcurrentRuns: 12,
      maxStartsPerMinute: null,
      minFreeMemoryMb: 2048,
      runMemoryEstimateMb: 300,
      minFreeHostMemoryMb: 15360,
      maxHostLoadPercentPerCore: 90,
    });
  });

  it("myrmidon(1.6.5): edits the host CPU ceiling and switches it off with an empty field", () => {
    const onSave = render(view);
    expect(field("maxHostLoadPercentPerCore").value).toBe("90");
    type("maxHostLoadPercentPerCore", "150");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ maxHostLoadPercentPerCore: 150 }));
    type("maxHostLoadPercentPerCore", "");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ maxHostLoadPercentPerCore: null }));
  });

  it("myrmidon(1.6.5 rc.2): shows the current host load and the background floor next to the ceiling", () => {
    render(view);
    const line = container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent ?? "";
    // The numbers the ceiling counts: the reading, the host's own background
    // and the part the runs add — the rc.1 panel showed only the typed number.
    expect(line).toContain("Host load right now: 120 % of a core");
    expect(line).toContain("load 19.2 on 16 core(s)");
    expect(line).toContain("5 % of a core above the host's background floor of 115 %");
    expect(line).toContain("Ceiling 90 %: open");
    // The hint says the ceiling counts the load above the host's background.
    expect(container.textContent).toContain("ABOVE the load the host carries on its own");
  });

  it("myrmidon(1.6.5 rc.2): names a closed ceiling and a switched-off one", () => {
    render({
      ...view,
      hostLoad: {
        ...view.hostLoad!,
        state: "closed",
        load1: 33.6,
        loadPercentPerCore: 210,
        loadAboveBackgroundPercent: 95,
      },
    });
    const closed = container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent ?? "";
    expect(closed).toContain("210 % of a core");
    expect(closed).toContain("95 % of a core above the host's background floor of 115 %");
    expect(closed).toContain("Ceiling 90 %: closed — new runs wait in the queue.");

    render({ ...view, hostLoad: { ...view.hostLoad!, state: "off", thresholdPercent: null } });
    expect(container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent).toBe(
      "Ceiling is off: new runs start whatever the host load is.",
    );
  });

  it("myrmidon(1.6.5 rc.2): shows no reading when the server sent none", () => {
    // An older server (or a request before the reading exists): the panel does
    // not invent a number.
    render({ ...view, hostLoad: null });
    expect(container.querySelector("[data-testid=runtime-limit-host-load]")).toBeNull();
  });

  it("myrmidon(1.6.2): edits the host free-memory floor and switches it off with an empty field", () => {
    const onSave = render(view);
    expect(field("minFreeHostMemoryMb").value).toBe("15360");
    type("minFreeHostMemoryMb", "12288");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ minFreeHostMemoryMb: 12288 }));
    type("minFreeHostMemoryMb", "");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ minFreeHostMemoryMb: null }));
  });

  it("refuses a value that is not a positive whole number and does not save", () => {
    const onSave = render(view);
    type("maxConcurrentRuns", "0");
    expect(container.querySelector("[data-testid=runtime-limit-error-maxConcurrentRuns]")).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("requires the per-run memory budget", () => {
    const onSave = render(view);
    type("runMemoryEstimateMb", "");
    expect(container.querySelector("[data-testid=runtime-limit-error-runMemoryEstimateMb]")?.textContent).toBe(
      "Required",
    );
    expect(saveButton().disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a save error from the server", () => {
    render(view, vi.fn(), false, "Instance admin access required");
    expect(container.textContent).toContain("Instance admin access required");
  });

  it("parses a draft without touching the view", () => {
    expect(
      parseRunLimitsDraft({
        maxConcurrentRuns: "",
        maxStartsPerMinute: " 3 ",
        minFreeMemoryMb: "",
        runMemoryEstimateMb: "300",
        minFreeHostMemoryMb: "15360",
        maxHostLoadPercentPerCore: "90",
      }),
    ).toEqual({
      patch: {
        maxConcurrentRuns: null,
        maxStartsPerMinute: 3,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: 15360,
        maxHostLoadPercentPerCore: 90,
      },
      errors: {},
    });
  });
});