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
  // myrmidon(1.6.5 RUN-ADMISSION rc.3): the live host reading the gate
  // decides on — busy percent, PSI, verdict.
  hostLoad: {
    state: "open",
    thresholdPercent: 90,
    load1: 19.2,
    cores: 16,
    loadPercentPerCore: 120,
    backgroundPercentPerCore: 115,
    load15PercentPerCore: 115,
    loadAboveBackgroundPercent: 5,
    cpuBusyPercent: 62,
    busyThresholdPercent: 90,
    psiSomeAvg10: null,
    psiThresholdPercent: null,
    source: "cpu-busy",
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
      maxPerAgentStartSharePercent: 15,
      // myrmidon(1.6.5 RUN-ADMISSION rc.3): an unserved key saves as off
      // (null), like every other optional ceiling.
      maxHostCpuBusyPercent: null,
      maxHostCpuPsiSomeAvg10: null,
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

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): the host line leads with the busy percent, the load average is auxiliary", () => {
    render(view);
    const line = container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent ?? "";
    // The deciding signal comes first: the measured busy percent against its
    // absolute threshold, then the verdict...
    expect(line).toContain("Host CPU right now: 62 % busy");
    expect(line).toContain("Ceiling 90 % busy: open — new runs start.");
    // ... and the load average follows as the auxiliary reading.
    expect(line).toContain(
      "Auxiliary: load average 120 % of a core (load 19.2 on 16 core(s)), 5 % of a core above the host's background floor of 115 %.",
    );
    // The busy hint names the absolute percent of all cores.
    expect(container.textContent).toContain("ABSOLUTE percent of all cores");
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): names a busy-closed gate with its reason and the PSI reading", () => {
    render({
      ...view,
      hostLoad: {
        ...view.hostLoad!,
        state: "closed",
        cpuBusyPercent: 93,
        psiSomeAvg10: 41,
        psiThresholdPercent: 40,
        reason: "host CPU is 93 % busy (non-idle share of all cores over the sample window) at or above the 90 % busy ceiling",
      },
    });
    const line = container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent ?? "";
    expect(line).toContain("Host CPU right now: 93 % busy, PSI some avg10 41 % (ceiling 40 %).");
    expect(line).toContain("Ceiling 90 % busy: closed — new runs wait in the queue");
    expect(line).toContain("(host CPU is 93 % busy");
    expect(line).toContain("Auxiliary: load average 120 % of a core");
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): an unmeasured first window and an unreadable counter render honestly", () => {
    render({ ...view, hostLoad: { ...view.hostLoad!, cpuBusyPercent: null } });
    const pending = container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent ?? "";
    expect(pending).toContain("busy % not measured yet");
    expect(pending).toContain("Ceiling 90 % busy: open");

    render({
      ...view,
      hostLoad: { ...view.hostLoad!, state: "unknown", reason: "cannot read /proc/stat" },
    });
    expect(container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent).toBe(
      "Host load is unreadable, so the ceiling is inactive: cannot read /proc/stat",
    );
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): edits the CPU busy and PSI ceilings and switches them off with an empty field", () => {
    const onSave = render(view);
    // An unserved key renders empty (off) like every other optional ceiling.
    expect(field("maxHostCpuBusyPercent").value).toBe("");
    expect(field("maxHostCpuPsiSomeAvg10").value).toBe("");
    type("maxHostCpuBusyPercent", "85");
    type("maxHostCpuPsiSomeAvg10", "40");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxHostCpuBusyPercent: 85, maxHostCpuPsiSomeAvg10: 40 }),
    );
    type("maxHostCpuBusyPercent", "");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ maxHostCpuBusyPercent: null }));
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): a legacy gate that still decides on load average keeps the old line", () => {
    render({
      ...view,
      hostLoad: {
        ...view.hostLoad!,
        state: "closed",
        source: "load-average",
        cpuBusyPercent: null,
        busyThresholdPercent: null,
        load1: 33.6,
        loadPercentPerCore: 210,
        loadAboveBackgroundPercent: 95,
      },
    });
    const closed = container.querySelector("[data-testid=runtime-limit-host-load]")?.textContent ?? "";
    expect(closed).toContain("Host load right now: 210 % of a core");
    expect(closed).toContain("95 % of a core above the host's background floor of 115 %");
    expect(closed).toContain("Ceiling 90 %: closed — new runs wait in the queue.");
  });

  it("myrmidon(1.6.5 rc.2): shows the current host load and the background floor next to the ceiling", () => {
    // rc.3 note: this is the legacy load-average line — mocked with
    // source: "load-average", the rule a settings row saved before rc.3 decides on.
    render({
      ...view,
      hostLoad: { ...view.hostLoad!, source: "load-average" },
    });
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
        source: "load-average",
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
        maxHostCpuBusyPercent: "85",
        maxHostCpuPsiSomeAvg10: "",
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
        maxHostCpuBusyPercent: 85,
        maxHostCpuPsiSomeAvg10: null,
      },
      errors: {},
    });
  });
});