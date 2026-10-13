// ui/src/ui2/screens/settings/runs-queue/Ui2RunsSettings.myrmidon.test.tsx
//
// myrmidon(UI2): screen guard for Settings → Runs & queue. Parity: the four
// admission ceilings render from the mocked runtime-limits API with their
// source labels, and the legacy PATCH action applies only the changed keys
// through the same runtimeLimitsApi the vendor panel uses.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2RunsSettings } from "./Ui2RunsSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";

const mockRuntimeLimitsApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

vi.mock("@/components/myrmidon/runtimeLimitsApi", () => ({
  runtimeLimitsApi: mockRuntimeLimitsApi,
  runtimeLimitsQueryKey: ["myrmidon", "runtime-limits"],
}));

// myrmidon(1.6.5 RUN-FAIRNESS): the screen reads the wait reason of the
// queue head from the existing live-runs endpoint — mocked here, no real API.
vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

// The screen reads the selected company for the live-runs query.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/**
 * myrmidon(1.6.5 rc.2): the GET view the screen renders, including the live
 * host CPU reading it shows next to the ceiling field.
 */
const openView = {
  limits: {
    maxConcurrentRuns: 24,
    maxStartsPerMinute: 12,
    minFreeMemoryMb: null,
    runMemoryEstimateMb: 1536,
    minFreeHostMemoryMb: 15360,
    maxHostLoadPercentPerCore: 90,
    // myrmidon(1.6.5 RUN-ADMISSION rc.3): the deciding ceilings.
    maxHostCpuBusyPercent: 90,
    maxHostCpuPsiSomeAvg10: null,
  },
  sources: {
    maxConcurrentRuns: "settings",
    maxStartsPerMinute: "settings",
    minFreeMemoryMb: "env",
    runMemoryEstimateMb: "default",
    minFreeHostMemoryMb: "default",
    maxHostLoadPercentPerCore: "default",
    // Not RunLimitKeys yet (part B predates the shared-key promotion), so an
    // older server's sources map has no entries for them — the screen must
    // fall back to "Default".
  },
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
  // myrmidon(1.6.5 RUN-FAIRNESS): the queue snapshot — a full ceiling and a
  // waiting queue with a named head.
  queue: {
    active: 50,
    limit: 51,
    queued: 3,
    oldestQueuedAt: "2026-10-06T08:00:00.000Z",
    oldestQueuedAgentId: "agent-1",
  },
  // myrmidon(1.6.5 C0-ui): the memory snapshot — the host's memory and the
  // server container's cgroup usage the screen shows under the queue block.
  memory: {
    host: { availableMb: 45056, totalMb: 131072 },
    container: { limitMb: 8192, usedMb: 3000, freeMb: 5192 },
  },
};

describe("myrmidon(UI2) Ui2RunsSettings screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderScreen() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2RunsSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockRuntimeLimitsApi.get.mockResolvedValue(openView);
    mockRuntimeLimitsApi.update.mockImplementation(async (_patch) => ({
      limits: {
        maxConcurrentRuns: 16,
        maxStartsPerMinute: 12,
        minFreeMemoryMb: null,
        runMemoryEstimateMb: 1536,
        minFreeHostMemoryMb: 15360,
        maxHostLoadPercentPerCore: 90,
      },
      sources: {
        maxConcurrentRuns: "settings",
        maxStartsPerMinute: "settings",
        minFreeMemoryMb: "env",
        runMemoryEstimateMb: "default",
        minFreeHostMemoryMb: "default",
        maxHostLoadPercentPerCore: "default",
      },
      // myrmidon(1.6.5 rc.2): the live host CPU reading the screen shows next
      // to the ceiling field.
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
      queue: {
        active: 10,
        limit: 51,
        queued: 0,
        oldestQueuedAt: null,
        oldestQueuedAgentId: null,
      },
      // myrmidon(1.6.5 C0-ui): the update response carries the memory snapshot too.
      memory: {
        host: { availableMb: 45056, totalMb: 131072 },
        container: { limitMb: 8192, usedMb: 3000, freeMb: 5192 },
      },
    }));
    // myrmidon(1.6.5 RUN-FAIRNESS): the live-runs list of the company — one
    // running, one queued with a wait reason (the oldest queued = the head).
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      {
        id: "run-1",
        status: "running",
        createdAt: "2026-10-06T09:00:00.000Z",
        agentId: "agent-2",
        agentName: "Runner",
        adapterType: "claude",
        invocationSource: "assignment",
        triggerDetail: null,
        startedAt: "2026-10-06T09:00:01.000Z",
        finishedAt: null,
      },
      {
        id: "run-2",
        status: "queued",
        createdAt: "2026-10-06T08:00:00.000Z",
        agentId: "agent-1",
        agentName: "Waiting",
        adapterType: "claude",
        invocationSource: "assignment",
        triggerDetail: null,
        startedAt: null,
        finishedAt: null,
        contextSnapshot: { waitReason: "agent_fair_share" },
      },
    ]);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the ceilings with their sources from the mocked API", async () => {
    await renderScreen();

    expect(mockRuntimeLimitsApi.get).toHaveBeenCalled();
    const inputs = [...container.querySelectorAll("input[id^='ui2-run-limit-']")];
    expect(inputs.length).toBe(9);
    // myrmidon(1.6.5 RUN-FAIRNESS): the single-agent start share renders at
    // its default 15 while the server does not serve the key yet.
    const share = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxPerAgentStartSharePercent");
    expect(share?.value).toBe("15");
    expect(share?.disabled).toBe(false);
    // myrmidon(1.6.5 RUN-ADMISSION rc.3): the deciding CPU ceilings are editable
    // here; the busy ceiling renders at 90, the off PSI ceiling empty/disabled.
    const busyCeiling = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxHostCpuBusyPercent");
    expect(busyCeiling?.value).toBe("90");
    expect(busyCeiling?.disabled).toBe(false);
    const psiCeiling = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxHostCpuPsiSomeAvg10");
    expect(psiCeiling?.value).toBe("");
    expect(psiCeiling?.disabled).toBe(true);
    // myrmidon(1.6.5 RUN-ADMISSION): the legacy load-average ceiling stays editable.
    const cpuCeiling = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxHostLoadPercentPerCore");
    expect(cpuCeiling?.value).toBe("90");
    expect(cpuCeiling?.disabled).toBe(false);
    // myrmidon(1.6.2 RUN-ADMISSION): the host free-memory floor is editable here too.
    const hostFloor = container.querySelector<HTMLInputElement>("#ui2-run-limit-minFreeHostMemoryMb");
    expect(hostFloor?.value).toBe("15360");
    expect(hostFloor?.disabled).toBe(false);
    const concurrent = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxConcurrentRuns");
    expect(concurrent?.value).toBe("24");
    // minFreeMemoryMb is null (off): its input renders empty and disabled.
    const memory = container.querySelector<HTMLInputElement>("#ui2-run-limit-minFreeMemoryMb");
    expect(memory?.value).toBe("");
    expect(memory?.disabled).toBe(true);
    // Source labels render per key.
    const body = container.textContent ?? "";
    expect(body).toContain("Saved here");
    expect(body).toContain("From the server environment");
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): shows the queue snapshot and the wait reason of the queue head", async () => {
    await renderScreen();

    const line = container.querySelector("[data-testid=ui2-run-queue]")?.textContent ?? "";
    expect(line).toContain("Runs in flight: 50 of at most 51.");
    expect(line).toContain("In the queue: 3");
    expect(line).toContain("the oldest waits since 08:00:00 UTC");
    expect(line).toContain("(agent agent-1)");
    // The oldest queued run carries waitReason=agent_fair_share — human-readable.
    const reason = container.querySelector("[data-testid=ui2-run-queue-wait-reason]")?.textContent ?? "";
    expect(reason).toContain("The oldest waits: another agent's turn comes first (fair share).");
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): an empty queue shows no wait reason; a missing snapshot shows no block", async () => {
    mockRuntimeLimitsApi.get.mockResolvedValue({
      ...openView,
      queue: { active: 10, limit: 51, queued: 0, oldestQueuedAt: null, oldestQueuedAgentId: null },
    });
    await renderScreen();
    expect(container.querySelector("[data-testid=ui2-run-queue]")?.textContent).toBe(
      "Runs in flight: 10 of at most 51. The queue is empty.",
    );
    expect(container.querySelector("[data-testid=ui2-run-queue-wait-reason]")).toBeNull();

    mockRuntimeLimitsApi.get.mockResolvedValue({ ...openView, queue: null });
    flushSync(() => root?.unmount());
    root = null;
    await renderScreen();
    expect(container.querySelector("[data-testid=ui2-run-queue]")).toBeNull();
  });

  it("myrmidon(1.6.5 C0-ui): shows the host and container memory; a missing snapshot shows no block", async () => {
    await renderScreen();
    const line = container.querySelector("[data-testid=ui2-run-memory]")?.textContent ?? "";
    expect(line).toContain("Host memory: 45056 MB available of 131072 MB.");
    expect(line).toContain("Server container: 3000 MB used of 8192 MB (5192 MB free).");

    mockRuntimeLimitsApi.get.mockResolvedValue({ ...openView, memory: null });
    flushSync(() => root?.unmount());
    root = null;
    await renderScreen();
    expect(container.querySelector("[data-testid=ui2-run-memory]")).toBeNull();
  });

  it("myrmidon(1.6.5 C0-ui): the memory block is localized (ru)", async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="ru">
            <Ui2RunsSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    const line = container.querySelector("[data-testid=ui2-run-memory]")?.textContent ?? "";
    expect(line).toContain("Память хоста: 45056 МБ свободно из 131072 МБ.");
    expect(line).toContain("Контейнер сервера: занято 3000 МБ из 8192 МБ (свободно 5192 МБ).");
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): the queue block and the fair-share field are localized (ru)", async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="ru">
            <Ui2RunsSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const body = container.textContent ?? "";
    expect(body).toContain("Доля стартов одного агента, % за 10 мин");
    const line = container.querySelector("[data-testid=ui2-run-queue]")?.textContent ?? "";
    expect(line).toContain("В работе: 50 из не более 51.");
    expect(line).toContain("В очереди: 3");
    expect(line).toContain("самый старый ждёт с 08:00:00 UTC");
    expect(line).toContain("(агент agent-1)");
    const reason = container.querySelector("[data-testid=ui2-run-queue-wait-reason]")?.textContent ?? "";
    expect(reason).toContain("Самый старый ждёт: очередь другого агента раньше (справедливая доля).");
  });

  it("myrmidon(1.6.5 RUN-FAIRNESS): edits the fair share and a share over 100 keeps Apply disabled", async () => {
    await renderScreen();

    const share = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxPerAgentStartSharePercent");
    expect(share).not.toBeNull();
    setNativeValue(share!, "30");
    await flushReact();
    expect(container.querySelector("[data-testid=ui2-run-limit-fair-share-error]")).toBeNull();

    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.click();
    await flushReact();
    expect(mockRuntimeLimitsApi.update).toHaveBeenCalledWith({ maxPerAgentStartSharePercent: 30 });

    mockRuntimeLimitsApi.update.mockClear();
    setNativeValue(share!, "150");
    await flushReact();
    expect(
      container.querySelector("[data-testid=ui2-run-limit-fair-share-error]")?.textContent,
    ).toContain("1 to 100");
    expect(save.disabled).toBe(true);
    save.click();
    await flushReact();
    expect(mockRuntimeLimitsApi.update).not.toHaveBeenCalled();
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): the host line leads with the busy percent, the load average is auxiliary", async () => {
    await renderScreen();

    // The deciding CPU busy label and hint render...
    const body = container.textContent ?? "";
    expect(body).toContain("Max host CPU busy (% of all cores)");
    expect(body).toContain("ABSOLUTE percent of all cores");
    // ... the legacy ceiling names itself deprecated ...
    expect(body).toContain("deprecated");
    // ... and the live line leads with the signal the gate decides on: the busy
    // percent with its threshold and verdict; the load average is auxiliary.
    const live = container.querySelector("[data-testid=ui2-run-limit-host-load]")?.textContent ?? "";
    expect(live).toContain("Host CPU right now: 62 % busy");
    expect(live).toContain("ceiling 90 % busy is open: new runs start");
    expect(live).toContain("Auxiliary: load average 120 % of a core (load 19.2 on 16 core(s))");
    expect(live).toContain("5 % of a core above the host's background floor of 115 %");
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): shows the busy-closed verdict with PSI and hides a missing reading", async () => {
    mockRuntimeLimitsApi.get.mockResolvedValue({
      ...openView,
      hostLoad: {
        ...openView.hostLoad,
        state: "closed",
        cpuBusyPercent: 93,
        psiSomeAvg10: 41,
        psiThresholdPercent: 40,
        reason: "host CPU is 93 % busy at or above the 90 % busy ceiling",
        heldSince: "2026-10-05T17:34:00.000Z",
      },
    });
    await renderScreen();
    const live = container.querySelector("[data-testid=ui2-run-limit-host-load]")?.textContent ?? "";
    expect(live).toContain("Host CPU right now: 93 % busy");
    expect(live).toContain("PSI some avg10 41 % (ceiling 40 %)");
    expect(live).toContain("ceiling 90 % busy is closed: new runs wait in the queue");
    expect(live).toContain("(host CPU is 93 % busy");
    expect(live).toContain("Auxiliary: load average 120 % of a core");

    // A server that sends no reading: no invented numbers.
    mockRuntimeLimitsApi.get.mockResolvedValue({ ...openView, hostLoad: null });
    flushSync(() => root?.unmount());
    root = null;
    await renderScreen();
    expect(container.querySelector("[data-testid=ui2-run-limit-host-load]")).toBeNull();
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): an unmeasured first window and an unreadable counter render honestly", async () => {
    mockRuntimeLimitsApi.get.mockResolvedValue({
      ...openView,
      hostLoad: { ...openView.hostLoad, cpuBusyPercent: null },
    });
    await renderScreen();
    const pending = container.querySelector("[data-testid=ui2-run-limit-host-load]")?.textContent ?? "";
    expect(pending).toContain("busy % not measured yet");
    expect(pending).toContain("ceiling 90 % busy is open");

    mockRuntimeLimitsApi.get.mockResolvedValue({
      ...openView,
      hostLoad: { ...openView.hostLoad, state: "unknown", reason: "cannot read /proc/stat" },
    });
    flushSync(() => root?.unmount());
    root = null;
    await renderScreen();
    expect(container.querySelector("[data-testid=ui2-run-limit-host-load]")?.textContent).toBe(
      "The host load cannot be read, so the ceiling is inactive: cannot read /proc/stat",
    );
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): a legacy gate that still decides on load average keeps the old line", async () => {
    mockRuntimeLimitsApi.get.mockResolvedValue({
      ...openView,
      hostLoad: {
        ...openView.hostLoad,
        state: "closed",
        source: "load-average",
        cpuBusyPercent: null,
        busyThresholdPercent: null,
        load1: 35,
        loadPercentPerCore: 219,
        loadAboveBackgroundPercent: 104,
        reason: "host load average 35.00 on 16 core(s) is 219 % of a core",
      },
    });
    await renderScreen();
    const live = container.querySelector("[data-testid=ui2-run-limit-host-load]")?.textContent ?? "";
    expect(live).toContain("Host now: 219 % of a core");
    expect(live).toContain("104 % of a core above the host's background floor of 115 %");
    expect(live).toContain("ceiling 90 % is closed");
  });

  it("myrmidon(1.6.5 RUN-ADMISSION rc.3): edits the CPU busy ceiling through the same PATCH api", async () => {
    await renderScreen();

    const busy = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxHostCpuBusyPercent");
    expect(busy).not.toBeNull();
    setNativeValue(busy!, "85");
    await flushReact();

    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.click();
    await flushReact();
    expect(mockRuntimeLimitsApi.update).toHaveBeenCalledWith({ maxHostCpuBusyPercent: 85 });
  });

  it("myrmidon(1.6.5 rc.2): shows the current host load and the background next to the ceiling field", async () => {
    // rc.3 note: this is the legacy load-average line — mocked with
    // source: "load-average", the rule a settings row saved before rc.3 decides on.
    mockRuntimeLimitsApi.get.mockResolvedValue({
      ...openView,
      hostLoad: { ...openView.hostLoad, source: "load-average" },
    });
    await renderScreen();

    // The label names what the number is measured against...
    const body = container.textContent ?? "";
    expect(body).toContain("above the host's background");
    // ... the hint explains it (deprecated since rc.3) ...
    expect(body).toContain("Only the load the runs add is counted");
    // ... and the live line carries the reading, the host's own background and
    // the verdict, so an operator sees why the fleet is running or waiting.
    const live = container.querySelector("[data-testid=ui2-run-limit-host-load]")?.textContent ?? "";
    expect(live).toContain("Host now: 120 % of a core");
    expect(live).toContain("load 19.2 on 16 core(s)");
    expect(live).toContain("5 % of a core above the host's background floor of 115 %");
    expect(live).toContain("ceiling 90 % is open");
  });

  it("myrmidon(1.6.5 rc.2): shows the closed verdict and hides a missing reading", async () => {
    mockRuntimeLimitsApi.get.mockResolvedValue({
      ...openView,
      hostLoad: {
        state: "closed",
        thresholdPercent: 90,
        load1: 35,
        cores: 16,
        loadPercentPerCore: 219,
        backgroundPercentPerCore: 115,
        load15PercentPerCore: 115,
        loadAboveBackgroundPercent: 104,
        cpuBusyPercent: null,
        busyThresholdPercent: null,
        psiSomeAvg10: null,
        psiThresholdPercent: null,
        source: "load-average",
        reason: "host load average 35.00 on 16 core(s) is 219 % of a core, ...",
        heldSince: "2026-10-05T17:34:00.000Z",
      },
    });
    await renderScreen();
    const live = container.querySelector("[data-testid=ui2-run-limit-host-load]")?.textContent ?? "";
    expect(live).toContain("219 % of a core");
    expect(live).toContain("104 % of a core above the host's background floor of 115 %");
    expect(live).toContain("ceiling 90 % is closed");

    // A server that sends no reading: no invented numbers.
    mockRuntimeLimitsApi.get.mockResolvedValue({ ...openView, hostLoad: null });
    flushSync(() => root?.unmount());
    root = null;
    await renderScreen();
    expect(container.querySelector("[data-testid=ui2-run-limit-host-load]")).toBeNull();
  });

  it("applies only the changed limit through the same PATCH api", async () => {
    await renderScreen();

    const concurrent = container.querySelector<HTMLInputElement>("#ui2-run-limit-maxConcurrentRuns");
    expect(concurrent).not.toBeNull();
    setNativeValue(concurrent!, "16");
    await flushReact();

    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    );
    expect(save).toBeDefined();
    expect((save as HTMLButtonElement | undefined)?.disabled).toBe(false);

    save?.click();
    await flushReact();

    expect(mockRuntimeLimitsApi.update).toHaveBeenCalledTimes(1);
    expect(mockRuntimeLimitsApi.update).toHaveBeenCalledWith({ maxConcurrentRuns: 16 });
  });
});
