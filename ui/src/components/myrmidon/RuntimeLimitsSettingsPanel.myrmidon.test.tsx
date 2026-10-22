// @vitest-environment jsdom
//
// myrmidon(C0) RUNTIME-LIMITS: the Run limits section of Instance → General.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunLimitKey, RunLimitsSource } from "@paperclipai/shared";
import type { RuntimeLimitsView } from "./runtimeLimitsApi";
import { RuntimeLimitsSettingsPanelView, parseRunLimitsDraft, type PanelLimitKey } from "./RuntimeLimitsSettingsPanel";

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
    // myrmidon(1.6.5 RUN-FAIRNESS part 2): the key is in the shared RunLimits type now.
    maxPerAgentStartSharePercent: 15,
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
  // myrmidon(1.6.5 RUN-FAIRNESS): the queue snapshot the endpoint reports.
  queue: null,
  // myrmidon(1.6.5 C0-ui): the memory snapshot the endpoint reports.
  memory: null,
};

function render(value: RuntimeLimitsView | null, onSave = vi.fn(), pending = false, error: string | null = null) {
  flushSync(() => {
    root.render(<RuntimeLimitsSettingsPanelView view={value} onSave={onSave} pending={pending} error={error} />);
  });
  return onSave;
}

function field(key: PanelLimitKey): HTMLInputElement {
  return container.querySelector(`#runtime-limit-${key}`) as HTMLInputElement;
}

function type(key: PanelLimitKey, text: string) {
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
      // myrmidon(1.6.5 RUN-FAIRNESS): the fair share ships at its default 15
      // until the server serves the key.
      maxPerAgentStartSharePercent: 15,
    });
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): edits the single-agent start share, default 15 until the server serves the key", () => {
    const onSave = render(view);
    // The server of this test predates part 2: no key in the payload — the
    // field renders at the default 15 and reports the default source.
    const share = field("maxPerAgentStartSharePercent");
    expect(share.value).toBe("15");
    expect(container.querySelector("[data-testid=runtime-limit-source-maxPerAgentStartSharePercent]")?.textContent).toBe(
      "Default",
    );
    type("maxPerAgentStartSharePercent", "25");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ maxPerAgentStartSharePercent: 25 }));
    // Empty = off (null in the patch).
    type("maxPerAgentStartSharePercent", "");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ maxPerAgentStartSharePercent: null }));
    // The served value wins over the default once part 2 lands — rendered on a
    // fresh mount, since a typed draft intentionally survives a re-render.
    flushSync(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render({ ...view, limits: { ...view.limits, maxPerAgentStartSharePercent: 40 } as RuntimeLimitsView["limits"] });
    expect(field("maxPerAgentStartSharePercent").value).toBe("40");
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): a share over 100 does not save", () => {
    const onSave = render(view);
    type("maxPerAgentStartSharePercent", "150");
    expect(
      container.querySelector("[data-testid=runtime-limit-error-maxPerAgentStartSharePercent]")?.textContent,
    ).toContain("1 to 100");
    expect(saveButton().disabled).toBe(true);
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): shows the queue snapshot — active, ceiling, queue length and the head", () => {
    render({
      ...view,
      queue: {
        active: 48,
        limit: 51,
        queued: 12,
        oldestQueuedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
        oldestQueuedAgentId: "agent-1",
      },
    });
    const line = container.querySelector("[data-testid=runtime-limit-queue]")?.textContent ?? "";
    expect(line).toContain("Runs in flight: 48 of at most 51.");
    expect(line).toContain("In the queue: 12");
    expect(line).toContain("the oldest waits since");
    expect(line).toContain("(agent agent-1)");
    expect(line).toContain("7 min ago");
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): an empty queue and a missing snapshot render cleanly", () => {
    render({ ...view, queue: { active: 3, limit: null, queued: 0, oldestQueuedAt: null, oldestQueuedAgentId: null } });
    expect(container.querySelector("[data-testid=runtime-limit-queue]")?.textContent).toBe(
      "Runs in flight: 3 of no concurrency ceiling. The queue is empty.",
    );
    render({ ...view, queue: null });
    expect(container.querySelector("[data-testid=runtime-limit-queue]")).toBeNull();
  });

  it("myrmidon(1.6.5 C0-ui): shows the host and container memory next to the queue", () => {
    render({
      ...view,
      memory: {
        host: { availableMb: 45056, totalMb: 131072 },
        container: { limitMb: 8192, usedMb: 3000, freeMb: 5192 },
      },
    });
    const line = container.querySelector("[data-testid=runtime-limit-memory]")?.textContent ?? "";
    expect(line).toContain("Host memory: 45,056 MB available of 131,072 MB");
    expect(line).toContain("Server container: 3,000 MB used of 8,192 MB (5,192 MB free)");
  });

  it("myrmidon(1.6.5 C0-ui): a missing memory snapshot or side renders cleanly", () => {
    render({ ...view, memory: { host: null, container: { limitMb: 8192, usedMb: 3000, freeMb: 5192 } } });
    const line = container.querySelector("[data-testid=runtime-limit-memory]")?.textContent ?? "";
    expect(line).not.toContain("Host memory");
    expect(line).toContain("Server container: 3,000 MB used");

    render({ ...view, memory: null });
    expect(container.querySelector("[data-testid=runtime-limit-memory]")).toBeNull();
  });

  it("myrmidon(1.6.5 F-09 B): shows the admission-refusal counter with the breakdown and the last refusal", () => {
    render({
      ...view,
      admissionDenials: {
        total: 12,
        // The reason the server counts most comes first, ties in the
        // admission's own order; a zero count is not a reason and is left out.
        byReason: { global_cap: 5, start_ramp: 4, host_cpu: 3, memory: 0 },
        lastReason: "host_cpu",
        lastAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
    });
    const line = container.querySelector("[data-testid=runtime-limit-admission-denials]")?.textContent ?? "";
    expect(line).toContain("Admission refusals: 12 since the server started.");
    expect(line).toContain("the concurrency ceiling is full x5");
    expect(line).toContain("the start ramp paces new starts x4");
    expect(line).toContain("the host CPU ceiling is closed x3");
    expect(line).not.toContain("free-memory floor");
    expect(line.indexOf("x5")).toBeLessThan(line.indexOf("x4"));
    expect(line).toContain("The last refusal: the host CPU ceiling is closed, at");
    expect(line).toContain("3 min ago");
  });

  it("myrmidon(1.6.5 F-09 B): a counter of zero and a half-filled one render cleanly", () => {
    render({ ...view, admissionDenials: { total: 0, byReason: {}, lastReason: null, lastAt: null } });
    expect(container.querySelector("[data-testid=runtime-limit-admission-denials]")?.textContent).toBe(
      "Admission refusals: none yet — every queued run the sweep saw had a free slot.",
    );

    // A reason this build does not know keeps its raw name; no breakdown and no
    // timestamp still renders the total.
    render({
      ...view,
      admissionDenials: { total: 1, byReason: { queue_paused: 1 }, lastReason: "queue_paused", lastAt: null },
    });
    const line = container.querySelector("[data-testid=runtime-limit-admission-denials]")?.textContent ?? "";
    expect(line).toContain("Admission refusals: 1 since the server started");
    expect(line).toContain("the admission refused it (queue_paused) x1");
    expect(line).toContain("The last refusal: the admission refused it (queue_paused).");
  });

  it("myrmidon(1.6.5 F-09 B): an older server without the counter shows no block", () => {
    // The field is optional: the panel does not invent a zero.
    render({ ...view, admissionDenials: null });
    expect(container.querySelector("[data-testid=runtime-limit-admission-denials]")).toBeNull();
    render({ ...view, admissionDenials: undefined });
    expect(container.querySelector("[data-testid=runtime-limit-admission-denials]")).toBeNull();
    // And the rest of the panel still renders.
    expect(field("maxConcurrentRuns").value).toBe("6");
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
        maxPerAgentStartSharePercent: "20",
      }),
    ).toEqual({
      patch: {
        maxConcurrentRuns: null,
        maxStartsPerMinute: 3,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: 15360,
        maxHostLoadPercentPerCore: 90,
        maxPerAgentStartSharePercent: 20,
      },
      errors: {},
    });
  });
});