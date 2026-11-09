// @vitest-environment jsdom
//
// myrmidon(1.7, OPE-4096, SETTINGS-TO-UI B, OPE-6249): UI tests for RunsQueueSettingsPanel.
// Covers:
// - Loading and error states
// - Renders boolean, number, string/json list keys and source labels (env, saved/ui, default)
// - Handles env override (field disabled)
// - Handles mutations for boolean toggles, number blur, and string/array blur
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunsQueueSettingsPanel } from "./RunsQueueSettingsPanel";
import { behaviorSettingsApi, type BehaviorSettingsView } from "./behaviorSettingsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const mockView: BehaviorSettingsView = {
  settings: {
    "runsQueue.idlePickup.enabled": true,
    "runsQueue.runStall.enabled": false,
    "runsQueue.autoResume.enabled": true,
    "runsQueue.pauseDrains.enabled": true,
    "runsQueue.skipIdleHeartbeats.enabled": false,
    "runsQueue.strandedAutopolicy.enabled": true,
    "runsQueue.settledHolds.blockExplicitWakes": true,
    "runsQueue.writeLock.requiresLiveRun": false,
    "runsQueue.taskPrSync.enabled": true,

    "runsQueue.idlePickup.wakeBudgetPerMin": 5,
    "runsQueue.idlePickup.wakeBatch": 5,
    "runsQueue.idlePickup.intervalSec": 15,
    "runsQueue.idlePickup.recentSuccessWindowMs": 60000,
    "runsQueue.runStall.thresholdSec": 60,
    "runsQueue.autoResume.maxAttempts": 3,
    "runsQueue.autoResume.intervalSec": 30,
    "runsQueue.autoResume.windowMs": 300000,
    "runsQueue.pauseResumeWake.batch": 10,
    "runsQueue.pauseResumeWake.batchPauseMs": 1000,
    "runsQueue.pendingInteractionWake.graceMs": 5000,
    "runsQueue.pendingInteractionWake.reAdmissions": 2,
    "runsQueue.outboxSweep.ageMs": 60000,
    "runsQueue.strandedAutopolicy.autoRetriesPerDay": 3,
    "runsQueue.crossIssueInfluence.limit": 5,
    "runsQueue.continuationHistory.limit": 20,
    "runsQueue.staleLease.graceMs": 30000,
    "runsQueue.swarm.supervisorTaskMax": 10,
    "runsQueue.dbBackup.catchupWindow": 3600,
    "runsQueue.workspaceHygiene.mergedCooldownMs": 86400000,
    "runsQueue.workspaceHygiene.stuckSignalAfterMs": 43200000,

    "runsQueue.autoResume.backoffMs": ["1000", "2000", "5000"],
    "runsQueue.infraInterrupt.codes": ["SIGTERM", "SIGINT"],
    "runsQueue.swarm.pilotBaselineDoc": "baseline-doc-v1",
  },
  sources: {
    "runsQueue.idlePickup.enabled": "ui",
    "runsQueue.runStall.enabled": "default",
    "runsQueue.autoResume.enabled": "env",
    "runsQueue.runStall.thresholdSec": "ui",
    "runsQueue.autoResume.maxAttempts": "default",
    "runsQueue.autoResume.backoffMs": "default",
    "runsQueue.infraInterrupt.codes": "ui",
    "runsQueue.swarm.pilotBaselineDoc": "default",
  },
};

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RunsQueueSettingsPanel />
      </QueryClientProvider>,
    );
  });
}

function getElementById<T extends HTMLElement>(id: string): T | null {
  return container.querySelector<T>(`[id="${id}"]`);
}

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("RunsQueueSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows loading state while fetching settings", () => {
    vi.spyOn(behaviorSettingsApi, "get").mockReturnValue(new Promise(() => {}));
    renderPanel();

    expect(container.textContent).toContain("Runs & Queue");
    expect(container.textContent).toContain("Loading settings...");
  });

  it("shows error alert when fetching settings fails", async () => {
    vi.spyOn(behaviorSettingsApi, "get").mockRejectedValue(new Error("Network Error"));
    renderPanel();

    await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.textContent).toContain("Failed to load settings.");
  });

  it("renders boolean, number, and string settings with source labels", async () => {
    vi.spyOn(behaviorSettingsApi, "get").mockResolvedValue(mockView);
    renderPanel();

    await waitFor(() => Boolean(container.querySelector('[data-testid="myrmidon-runs-queue-settings"]')));
    expect(container.textContent).toContain("Core switches");
    expect(container.textContent).toContain("Advanced tuning");

    // Boolean with 'ui' (saved) source
    const idleSwitch = getElementById<HTMLButtonElement>("runsQueue.idlePickup.enabled");
    expect(idleSwitch).not.toBeNull();
    expect(idleSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(idleSwitch?.disabled).toBe(false);

    // Boolean with 'default' source
    const stallSwitch = getElementById<HTMLButtonElement>("runsQueue.runStall.enabled");
    expect(stallSwitch).not.toBeNull();
    expect(stallSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(stallSwitch?.disabled).toBe(false);

    // Boolean with 'env' (env override) source -> disabled
    const resumeSwitch = getElementById<HTMLButtonElement>("runsQueue.autoResume.enabled");
    expect(resumeSwitch).not.toBeNull();
    expect(resumeSwitch?.disabled).toBe(true);

    // Number with 'ui' source
    const stallThreshold = getElementById<HTMLInputElement>("runsQueue.runStall.thresholdSec");
    expect(stallThreshold).not.toBeNull();
    expect(stallThreshold?.type).toBe("number");
    expect(stallThreshold?.value).toBe("60");
    expect(stallThreshold?.disabled).toBe(false);

    // String / array with 'ui' source
    const infraCodes = getElementById<HTMLInputElement>("runsQueue.infraInterrupt.codes");
    expect(infraCodes).not.toBeNull();
    expect(infraCodes?.value).toBe("SIGTERM, SIGINT");
    expect(infraCodes?.disabled).toBe(false);

    // String with 'default' source
    const pilotDoc = getElementById<HTMLInputElement>("runsQueue.swarm.pilotBaselineDoc");
    expect(pilotDoc).not.toBeNull();
    expect(pilotDoc?.value).toBe("baseline-doc-v1");
    expect(pilotDoc?.disabled).toBe(false);

    // Check source labels rendered in the panel
    expect(container.textContent).toContain("env override");
    expect(container.textContent).toContain("saved");
    expect(container.textContent).toContain("default");
  });

  it("mutates boolean setting when toggled", async () => {
    const updateSpy = vi.spyOn(behaviorSettingsApi, "update").mockResolvedValue(mockView);
    vi.spyOn(behaviorSettingsApi, "get").mockResolvedValue(mockView);
    renderPanel();

    await waitFor(() => Boolean(getElementById("runsQueue.idlePickup.enabled")));
    const idleSwitch = getElementById<HTMLButtonElement>("runsQueue.idlePickup.enabled")!;

    act(() => {
      idleSwitch.click();
    });

    await waitFor(() => updateSpy.mock.calls.length > 0);
    expect(updateSpy).toHaveBeenCalledWith({
      "runsQueue.idlePickup.enabled": false,
    });
  });

  it("mutates number setting on blur after value change", async () => {
    const updateSpy = vi.spyOn(behaviorSettingsApi, "update").mockResolvedValue(mockView);
    vi.spyOn(behaviorSettingsApi, "get").mockResolvedValue(mockView);
    renderPanel();

    await waitFor(() => Boolean(getElementById("runsQueue.runStall.thresholdSec")));
    const stallThreshold = getElementById<HTMLInputElement>("runsQueue.runStall.thresholdSec")!;

    setInputValue(stallThreshold, "120");

    act(() => {
      stallThreshold.dispatchEvent(new Event("blur", { bubbles: true }));
    });

    await waitFor(() => updateSpy.mock.calls.length > 0);
    expect(updateSpy).toHaveBeenCalledWith({
      "runsQueue.runStall.thresholdSec": 120,
    });
  });

  it("mutates array setting on blur after value change", async () => {
    const updateSpy = vi.spyOn(behaviorSettingsApi, "update").mockResolvedValue(mockView);
    vi.spyOn(behaviorSettingsApi, "get").mockResolvedValue(mockView);
    renderPanel();

    await waitFor(() => Boolean(getElementById("runsQueue.infraInterrupt.codes")));
    const infraCodes = getElementById<HTMLInputElement>("runsQueue.infraInterrupt.codes")!;

    setInputValue(infraCodes, "SIGUSR1, SIGUSR2");

    act(() => {
      infraCodes.dispatchEvent(new Event("blur", { bubbles: true }));
    });

    await waitFor(() => updateSpy.mock.calls.length > 0);
    expect(updateSpy).toHaveBeenCalledWith({
      "runsQueue.infraInterrupt.codes": ["SIGUSR1", "SIGUSR2"],
    });
  });

  it("mutates string setting on blur after value change", async () => {
    const updateSpy = vi.spyOn(behaviorSettingsApi, "update").mockResolvedValue(mockView);
    vi.spyOn(behaviorSettingsApi, "get").mockResolvedValue(mockView);
    renderPanel();

    await waitFor(() => Boolean(getElementById("runsQueue.swarm.pilotBaselineDoc")));
    const pilotDoc = getElementById<HTMLInputElement>("runsQueue.swarm.pilotBaselineDoc")!;

    setInputValue(pilotDoc, "baseline-doc-v2");

    act(() => {
      pilotDoc.dispatchEvent(new Event("blur", { bubbles: true }));
    });

    await waitFor(() => updateSpy.mock.calls.length > 0);
    expect(updateSpy).toHaveBeenCalledWith({
      "runsQueue.swarm.pilotBaselineDoc": "baseline-doc-v2",
    });
  });

  it("does not mutate when blurring without changing value", async () => {
    const updateSpy = vi.spyOn(behaviorSettingsApi, "update").mockResolvedValue(mockView);
    vi.spyOn(behaviorSettingsApi, "get").mockResolvedValue(mockView);
    renderPanel();

    await waitFor(() => Boolean(getElementById("runsQueue.runStall.thresholdSec")));
    const stallThreshold = getElementById<HTMLInputElement>("runsQueue.runStall.thresholdSec")!;

    act(() => {
      stallThreshold.dispatchEvent(new Event("blur", { bubbles: true }));
    });

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
