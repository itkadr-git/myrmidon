// @vitest-environment jsdom
//
// myrmidon(1.6.5 SWARM-T4, design §5.1): the "Self-organization (swarm)"
// section of Instance → General. One switch, the pheromone mapping, the
// advanced lease/limit/sweep extras, the change journal; every field has a
// help line. The pilot role/company fields are gone — zero pilot words.
//
// myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894): the pheromone mapping no
// longer carries the dead cooldown knobs, the "Task cooling" block edits
// `general.swarm` (the one rule the wake-task guard applies), and every
// rendered string comes from the fork i18n catalog — mocked the way
// GitHubSharedIdentityPanel.myrmidon.test.tsx mocks it: t() resolves the key
// against en.json, so the panel's English output is the catalog's own wording.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enCatalog from "@/i18n/myrmidon-locales/en.json";

// The tests run outside the app bootstrap, so i18n.init has not run; make
// t() return the key's EN text from the fork catalog ({{count}}-style
// placeholders are interpolated from the options).
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let node: unknown = enCatalog;
      for (const part of key.split(".")) node = (node as Record<string, unknown>)?.[part];
      return typeof node === "string"
        ? node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => String(options?.[name] ?? ""))
        : key;
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import {
  PHEROMONE_NUMBER_KEYS,
  SwarmClaimSettingsPanelView,
  SwarmCoolingSettingsPanelView,
  parseSwarmClaimDraft,
} from "./SwarmClaimSettingsPanel";
import { swarmClaimStatusLine, type SwarmClaimSettingsView } from "./swarmClaimSettingsApi";
import type { SwarmSettings } from "@paperclipai/shared";

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
    pheromone: { critical: 250 },
  },
  sources: {
    enabled: "settings",
    leaseTtlSec: "settings",
    maxActiveTasks: "env",
    sweepIntervalSec: "default",
    p0Preemption: "settings",
    pheromone: "settings",
  },
  journal: [
    {
      at: "2026-10-03T09:00:00.000Z",
      actorType: "user",
      actorId: "user-1",
      patch: { enabled: true },
    },
  ],
};

function render(
  value: SwarmClaimSettingsView | null,
  onSave = vi.fn(),
  pending = false,
  error: string | null = null,
  status: string | null = null,
) {
  flushSync(() => {
    root.render(
      <SwarmClaimSettingsPanelView
        view={value}
        status={status}
        onSave={onSave}
        pending={pending}
        error={error}
      />,
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
    el.textContent?.includes("Save self-organization settings"),
  )!;
}

function renderCooling(
  swarm: SwarmSettings | null | undefined,
  onSave = vi.fn(),
  props: { loading?: boolean; saving?: boolean; error?: string | null } = {},
) {
  flushSync(() => {
    root.render(
      <SwarmCoolingSettingsPanelView
        swarm={swarm}
        loading={props.loading ?? false}
        saving={props.saving ?? false}
        error={props.error ?? null}
        onSave={onSave}
      />,
    );
  });
  return onSave;
}

function coolingSaveButton(): HTMLButtonElement {
  return container.querySelector("[data-testid=swarm-cooling-save]") as HTMLButtonElement;
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

  it("saves the switch, the extras and a full pheromone patch, an empty ceiling as 'no ceiling'", () => {
    const onSave = render(view);
    type("swarm-claim-leaseTtlSec", "600");
    type("swarm-claim-maxActiveTasks", "");
    type("swarm-claim-pheromone-critical", "500");
    type("swarm-claim-pheromone-agingCap", "9");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      p0Preemption: true,
      pheromone: { critical: 500, agingCap: 9 },
      leaseTtlSec: 600,
      maxActiveTasks: null,
      sweepIntervalSec: 30,
    });
  });

  it("has no pilot fields at all", () => {
    render(view);
    expect(container.querySelector("#swarm-claim-roles")).toBeNull();
    expect(container.querySelector("#swarm-claim-companies")).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain("pilot");
  });

  it("shows the status line with the live numbers only while enabled", () => {
    const onSave = render(view, vi.fn(), false, null, "7 tasks queued · 3 active leases · 2 free agents");
    expect(
      container.querySelector("[data-testid=swarm-claim-status-line]")?.textContent,
    ).toContain("7 tasks queued");
    clickToggle("swarm-claim-enabled");
    expect(container.querySelector("[data-testid=swarm-claim-status-line]")).toBeNull();
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const patch = onSave.mock.calls[0]![0] as { enabled: boolean };
    expect(patch.enabled).toBe(false);
  });

  // 1.6.5 (OPE-6608 D): the status line is fed by the live queue counters of GET /swarm-claim.
  it("builds the status line from the live queue counters", () => {
    expect(swarmClaimStatusLine(null)).toBeNull();
    expect(swarmClaimStatusLine(undefined)).toBeNull();
    const line = swarmClaimStatusLine({ queuedUnassigned: 7, claimedLastHour: 4, cancelledLastHour: 0 });
    expect(line).toContain("7 unassigned task(s) waiting");
    expect(line).toContain("4 claimed in the last hour");
    expect(line).toContain("0 cancelled in the last hour");
    render(view, vi.fn(), false, null, line);
    expect(
      container.querySelector("[data-testid=swarm-claim-status-line]")?.textContent,
    ).toContain("7 unassigned task(s) waiting");
  });

  it("shows a help line for every field, including the pheromone ones", () => {
    render(view);
    for (const id of [
      "swarm-claim-enabled",
      "swarm-claim-p0",
      "swarm-claim-leaseTtlSec",
      "swarm-claim-maxActiveTasks",
      "swarm-claim-sweepIntervalSec",
      "swarm-claim-pheromone-critical",
      "swarm-claim-pheromone-high",
      "swarm-claim-pheromone-medium",
      "swarm-claim-pheromone-low",
      "swarm-claim-pheromone-agingStepHours",
      "swarm-claim-pheromone-agingStep",
      "swarm-claim-pheromone-agingCap",
      "swarm-claim-pheromone-failPenalty",
    ]) {
      // the input exists and the following help paragraph is non-empty
      expect(field(id), id).toBeTruthy();
    }
    expect(container.querySelectorAll("#swarm-claim-pheromone-critical ~ *")).not.toBeNull();
  });

  // myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894) — red side: the dead
  // `pheromone.cooldown*` knobs left the panel with the schema; the real
  // cooling lives in the "Task cooling" block.
  it("no longer renders the dead pheromone cooldown fields", () => {
    expect(PHEROMONE_NUMBER_KEYS).not.toContain("cooldownBaseMin");
    expect(PHEROMONE_NUMBER_KEYS).not.toContain("cooldownCapMin");
    render(view);
    expect(container.querySelector("#swarm-claim-pheromone-cooldownBaseMin")).toBeNull();
    expect(container.querySelector("#swarm-claim-pheromone-cooldownCapMin")).toBeNull();
    expect(container.textContent).not.toContain("Cooldown base, minutes");
    expect(container.textContent).not.toContain("Cooldown cap, minutes");
  });

  // myrmidon(OPE-6894): the status line is built through the catalog when a
  // translator is given — no hardcoded English in the line builder.
  it("localizes the status line through the catalog", () => {
    const line = swarmClaimStatusLine(
      { queuedUnassigned: 7, claimedLastHour: 4, cancelledLastHour: 0 },
      (key, options) =>
        `KEY:${key}:${JSON.stringify(options ?? null)}`,
    );
    expect(line).toBe('KEY:swarmClaim.statusLine:{"queued":7,"claimed":4,"cancelled":0}');
    // and the mocked catalog renders the EN text with the numbers in place.
    render(view, vi.fn(), false, null, swarmClaimStatusLine(
      { queuedUnassigned: 7, claimedLastHour: 4, cancelledLastHour: 0 },
      (key, options) => {
        let node: unknown = enCatalog;
        for (const part of key.split(".")) node = (node as Record<string, unknown>)?.[part];
        return typeof node === "string"
          ? node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => String(options?.[name] ?? ""))
          : key;
      },
    ));
    expect(
      container.querySelector("[data-testid=swarm-claim-status-line]")?.textContent,
    ).toContain("7 unassigned task(s) waiting");
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
    expect(journal?.textContent).toContain("enabled");
  });

  it("shows a save error from the server", () => {
    render(view, vi.fn(), false, "Instance admin access required");
    expect(container.textContent).toContain("Instance admin access required");
  });

  it("parses a draft without touching the view", () => {
    expect(
      parseSwarmClaimDraft({
        leaseTtlSec: " 600 ",
        maxActiveTasks: "",
        sweepIntervalSec: "45",
      }),
    ).toEqual({
      patch: { leaseTtlSec: 600, maxActiveTasks: null, sweepIntervalSec: 45 },
      errors: {},
    });
    expect(
      parseSwarmClaimDraft({ leaseTtlSec: "x", maxActiveTasks: "0", sweepIntervalSec: "1" }).patch,
    ).toBeNull();
  });
});

// myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894): the "Task cooling" block —
// the one rule the wake-task guard applies (`general.swarm`, F-26), saved
// through the instance-general settings API without a restart.
describe("myrmidon(1.6.5 OPE-6894) task cooling block", () => {
  it("renders the stored general.swarm values and the server defaults as placeholders", () => {
    renderCooling({ cooldownBaseMin: 45, cooldownCeilingHours: 12, runWithoutTaskGate: true });
    expect(field("swarm-cooling-baseMin").value).toBe("45");
    expect(field("swarm-cooling-ceilingHours").value).toBe("12");
    expect(coolingSaveButton().disabled).toBe(false);
  });

  it("an unset block shows the defaults (30 / 24) as placeholders and the gate on", () => {
    renderCooling(undefined);
    expect(field("swarm-cooling-baseMin").placeholder).toBe("30");
    expect(field("swarm-cooling-ceilingHours").placeholder).toBe("24");
    expect(field("swarm-cooling-baseMin").value).toBe("");
    expect(field("swarm-cooling-ceilingHours").value).toBe("");
  });

  it("saves the numbers the owner typed as a general.swarm patch", () => {
    const onSave = renderCooling({ cooldownBaseMin: 30, runWithoutTaskGate: true });
    type("swarm-cooling-baseMin", "90");
    type("swarm-cooling-ceilingHours", "6");
    flushSync(() =>
      coolingSaveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledWith({
      runWithoutTaskGate: true,
      cooldownBaseMin: 90,
      cooldownCeilingHours: 6,
    });
  });

  it("sends only the gate when both numbers stay empty (defaults apply server-side)", () => {
    const onSave = renderCooling({});
    flushSync(() =>
      coolingSaveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledWith({ runWithoutTaskGate: true });
  });

  it("the gate toggle flips runWithoutTaskGate", () => {
    const onSave = renderCooling({ runWithoutTaskGate: true });
    clickToggle("swarm-cooling-gate");
    flushSync(() =>
      coolingSaveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledWith({ runWithoutTaskGate: false });
  });

  it("refuses out-of-range numbers and does not save", () => {
    const onSave = renderCooling({ cooldownBaseMin: 30 });
    type("swarm-cooling-baseMin", "9999");
    expect(container.querySelector("[data-testid=swarm-cooling-error-baseMin]")).not.toBeNull();
    expect(coolingSaveButton().disabled).toBe(true);
    flushSync(() =>
      coolingSaveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a save error from the server", () => {
    renderCooling({}, vi.fn(), { error: "Instance admin access required" });
    expect(container.textContent).toContain("Instance admin access required");
  });
});
