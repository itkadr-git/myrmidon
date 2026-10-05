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

vi.mock("@/components/myrmidon/runtimeLimitsApi", () => ({
  runtimeLimitsApi: mockRuntimeLimitsApi,
  runtimeLimitsQueryKey: ["myrmidon", "runtime-limits"],
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
  },
  sources: {
    maxConcurrentRuns: "settings",
    maxStartsPerMinute: "settings",
    minFreeMemoryMb: "env",
    runMemoryEstimateMb: "default",
    minFreeHostMemoryMb: "default",
    maxHostLoadPercentPerCore: "default",
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
    reason: null,
    heldSince: null,
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
        reason: null,
        heldSince: null,
      },
    }));
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the six ceilings with their sources from the mocked API", async () => {
    await renderScreen();

    expect(mockRuntimeLimitsApi.get).toHaveBeenCalled();
    const inputs = [...container.querySelectorAll("input[id^='ui2-run-limit-']")];
    expect(inputs.length).toBe(6);
    // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling is editable here too.
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

  it("myrmidon(1.6.5 rc.2): shows the current host load and the background next to the ceiling field", async () => {
    await renderScreen();

    // The label names what the number is measured against...
    const body = container.textContent ?? "";
    expect(body).toContain("above the host's background");
    // ... the hint explains it ...
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
