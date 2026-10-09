// @vitest-environment jsdom
//
// myrmidon(1.6.1 SWARM-SETTINGS-UI): the "Self-organisation (swarm)" section
// of Instance → General. The panel is the settings half of the 1.6.1 task:
// values apply without a restart, each field shows where the effective value
// came from, and the journal shows who changed what and when.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmClaimSettingsPanelView, parseSwarmClaimDraft } from "./SwarmClaimSettingsPanel";
import type { SwarmClaimSettingsView } from "./swarmClaimSettingsApi";

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

const view: SwarmClaimSettingsView = {
  settings: {
    enabled: true,
    leaseTtlSec: 900,
    maxActiveTasks: 3,
    sweepIntervalSec: 30,
    p0Preemption: true,
  },
  sources: {
    enabled: "settings",
    leaseTtlSec: "settings",
    maxActiveTasks: "env",
    sweepIntervalSec: "default",
    p0Preemption: "settings",
  },
  journal: [
    {
      at: "2026-10-03T09:00:00.000Z",
      actorType: "user",
      actorId: "user-1",
      patch: { enabled: true, leaseTtlSec: 900 },
    },
  ],
};

function render(
  value: SwarmClaimSettingsView | null,
  onSave = vi.fn(),
  pending = false,
  error: string | null = null,
) {
  flushSync(() => {
    root.render(
      <SwarmClaimSettingsPanelView view={value} onSave={onSave} pending={pending} error={error} />,
    );
  });
  return onSave;
}

function field(id: string): HTMLInputElement {
  return container.querySelector(`#${id}`) as HTMLInputElement;
}

function type(id: string, text: string) {
  const input = field(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickToggle(id: string) {
  const toggle = container.querySelector(`#${id}`) as HTMLButtonElement;
  flushSync(() => {
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Save swarm settings"),
  )!;
}

describe("myrmidon(1.6.1) swarm claim settings panel", () => {
  it("shows the effective values with where each one came from", () => {
    render(view);
    expect(field("swarm-claim-leaseTtlSec").value).toBe("900");
    expect(field("swarm-claim-maxActiveTasks").value).toBe("3");
    expect(field("swarm-claim-sweepIntervalSec").value).toBe("30");
    expect(
      container.querySelector("[data-testid=swarm-claim-source-leaseTtlSec]")?.textContent,
    ).toBe("Saved here");
    expect(
      container.querySelector("[data-testid=swarm-claim-source-maxActiveTasks]")?.textContent,
    ).toBe("Environment override");
    expect(
      container.querySelector("[data-testid=swarm-claim-source-sweepIntervalSec]")?.textContent,
    ).toBe("Default");
  });

  it("shows the live queue counters the sweep reports", () => {
    render({
      ...view,
      counters: { queuedUnassigned: 4, claimedLastHour: 1, cancelledLastHour: 2 },
    });
    expect(container.textContent).toContain("4 unassigned task(s) waiting");
    expect(container.textContent).toContain("1 claimed in the last hour");
    expect(container.textContent).toContain("2 cancelled in the last hour");
  });

  it("saves every field, an empty ceiling as 'no ceiling'", () => {
    const onSave = render(view);
    type("swarm-claim-leaseTtlSec", "600");
    type("swarm-claim-maxActiveTasks", "");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      p0Preemption: true,
      leaseTtlSec: 600,
      maxActiveTasks: null,
      sweepIntervalSec: 30,
    });
  });

  it("has no pilot scope and no idle-wake batch: one switch, the caste directory decides who takes part", () => {
    render(view);
    expect(field("swarm-claim-roles")).toBeNull();
    expect(field("swarm-claim-companies")).toBeNull();
    expect(field("swarm-claim-idleWakeBatch")).toBeNull();
    expect(container.textContent).not.toMatch(/pilot|in scope|idle wake/i);
    expect(container.textContent).toContain("caste");
  });

  it("switching the swarm off is part of the patch", () => {
    const onSave = render(view);
    clickToggle("swarm-claim-enabled");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const patch = onSave.mock.calls[0]![0] as { enabled: boolean };
    expect(patch.enabled).toBe(false);
  });

  it("refuses an out-of-range TTL and does not save", () => {
    const onSave = render(view);
    type("swarm-claim-leaseTtlSec", "10");
    expect(container.querySelector("[data-testid=swarm-claim-error-leaseTtlSec]")).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the change journal with who and when", () => {
    render(view);
    const journal = container.querySelector("[data-testid=swarm-claim-journal]");
    expect(journal?.textContent).toContain("user:user-1");
    expect(journal?.textContent).toContain("enabled, leaseTtlSec");
  });

  it("shows a save error from the server", () => {
    render(view, vi.fn(), false, "Instance admin access required");
    expect(container.textContent).toContain("Instance admin access required");
  });

  it("shows the live queue counters when the server reports them", () => {
    render({
      ...view,
      counters: { queuedUnassigned: 3, claimedLastHour: 1, cancelledLastHour: 0 },
    });
    expect(
      container.querySelector("[data-testid=swarm-claim-counter-queued]")?.textContent,
    ).toContain("3");
    expect(
      container.querySelector("[data-testid=swarm-claim-counter-claimed]")?.textContent,
    ).toContain("1 claimed");
    expect(
      container.querySelector("[data-testid=swarm-claim-counter-cancelled]")?.textContent,
    ).toContain("0 cancelled");
    // A view without counters (a PATCH response) renders no counter block.
    render(view);
    expect(container.querySelector("[data-testid=swarm-claim-counters]")).toBeNull();
  });

  it("parses a draft without touching the view", () => {
    expect(
      parseSwarmClaimDraft({ leaseTtlSec: " 600 ", maxActiveTasks: "", sweepIntervalSec: "45" }),
    ).toEqual({
      patch: { leaseTtlSec: 600, maxActiveTasks: null, sweepIntervalSec: 45 },
      errors: {},
    });
    expect(
      parseSwarmClaimDraft({ leaseTtlSec: "x", maxActiveTasks: "0", sweepIntervalSec: "1" }).patch,
    ).toBeNull();
  });
});
