// @vitest-environment jsdom
//
// myrmidon(1.6.7 SETTINGS-GENERAL-CRASH): the Runs & Queue panel on
// Settings -> General. It read `values[]` from the behavior-settings response;
// the server sends `{ settings, sources }`, so the page crashed ("values is not
// iterable") a few seconds after opening. The view is rendered here with the
// served shape, with the old and other unexpected shapes, and with a request
// error: only the panel may show an error, nothing may throw into the page.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunsQueueSettingsPanelView } from "./RunsQueueSettingsPanel";

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

const SERVED = {
  settings: {
    "runsQueue.idlePickup.wakeBatch": 5,
    "runsQueue.idlePickup.enabled": true,
    "runsQueue.idlePickup.recentSuccessWindowMs": 1800000,
    "runsQueue.autoResume.backoffMs": [60000, 300000, 900000],
    "runsQueue.swarm.pilotBaselineDoc": "baseline-snapshot-14d",
  },
  sources: {
    "runsQueue.idlePickup.wakeBatch": "default",
    "runsQueue.idlePickup.enabled": "default",
    "runsQueue.idlePickup.recentSuccessWindowMs": "env",
    "runsQueue.autoResume.backoffMs": "default",
    "runsQueue.swarm.pilotBaselineDoc": "default",
  },
};

function render(props: Parameters<typeof RunsQueueSettingsPanelView>[0]) {
  flushSync(() => {
    root.render(<RunsQueueSettingsPanelView {...props} />);
  });
}

function field(key: string): HTMLInputElement | null {
  return container.querySelector(`[id="${key}"]`);
}

describe("Runs & Queue panel", () => {
  it("renders the fields of the { settings, sources } response with their values", () => {
    render({ data: SERVED });
    expect(container.querySelector('[data-testid="runs-queue-settings-error"]')).toBeNull();
    expect(field("runsQueue.idlePickup.wakeBatch")?.value).toBe("5");
    expect(field("runsQueue.autoResume.backoffMs")?.value).toBe("60000, 300000, 900000");
    expect(field("runsQueue.swarm.pilotBaselineDoc")?.value).toBe("baseline-snapshot-14d");
  });

  it("shows a value pinned by the environment read-only", () => {
    render({ data: SERVED });
    expect(field("runsQueue.idlePickup.recentSuccessWindowMs")?.disabled).toBe(true);
    expect(field("runsQueue.idlePickup.wakeBatch")?.disabled).toBe(false);
  });

  it("renders the typed-but-unsaved text instead of the served value", () => {
    render({ data: SERVED, drafts: { "runsQueue.idlePickup.wakeBatch": "9" } });
    expect(field("runsQueue.idlePickup.wakeBatch")?.value).toBe("9");
  });

  it("shows no error and no fields while the request is in flight", () => {
    render({ data: undefined });
    expect(container.querySelector('[data-testid="myrmidon-runs-queue-settings"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="runs-queue-settings-error"]')).toBeNull();
    expect(field("runsQueue.idlePickup.wakeBatch")).toBeNull();
  });

  it("shows an error inside the panel, and does not throw, for a body of any other shape", () => {
    const bodies: unknown[] = [null, [], "settings", 5, {}, { values: [] }, { settings: null }];
    for (const data of bodies) {
      expect(() => render({ data })).not.toThrow();
      expect(container.querySelector('[data-testid="myrmidon-runs-queue-settings"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="runs-queue-settings-error"]')).toBeTruthy();
      expect(field("runsQueue.idlePickup.wakeBatch")).toBeNull();
    }
  });

  it("shows the request error inside the panel", () => {
    const error = Object.assign(new Error("Instance admin access required"), { status: 403 });
    expect(() => render({ data: undefined, error })).not.toThrow();
    const box = container.querySelector('[data-testid="runs-queue-settings-error"]');
    expect(box).toBeTruthy();
    expect(box?.getAttribute("role")).toBe("alert");
  });

  it("shows a failed save and an unparsable entry above the fields", () => {
    render({ data: SERVED, saveError: "Saving the setting failed.", invalidKey: "runsQueue.idlePickup.wakeBatch" });
    expect(container.querySelector('[data-testid="runs-queue-settings-save-error"]')?.textContent).toBe(
      "Saving the setting failed.",
    );
    expect(container.querySelector('[data-testid="runs-queue-settings-invalid"]')).toBeTruthy();
    expect(field("runsQueue.idlePickup.wakeBatch")?.getAttribute("aria-invalid")).toBe("true");
  });
});
