// @vitest-environment jsdom
//
// myrmidon(1.6.5 RUN-PRIORITY B): the queue priority section of
// Instance → General — source, whole-number validation within the server bounds, the save
// patch shape, and the honest "not served" state on an older server.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunPriorityView } from "./runQueueApi";
import {
  RunQueuePrioritySettingsPanelView,
  parseRunPriorityDraft,
} from "./RunQueuePrioritySettingsPanel";

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

const view: RunPriorityView = {
  settings: {
    enabled: true,
    roleWeights: { review: 100, release: 90, lead: 40, engineer: 20, docs: 10, custom: 33 },
    defaultRoleWeight: 30,
    issuePriorityWeights: { critical: 100, high: 80, medium: 60, low: 40, none: 20 },
    currentRelease: "1.6.5",
    releaseBonus: 25,
    agingStepMinutes: 10,
    agingStepWeight: 5,
    agingMaxBonus: 50,
    starvationLimitMinutes: 90,
    starvationTopWeight: 10_000,
  },
  source: "settings",
};

const emptyDraft = {
  review: "", release: "", lead: "", engineer: "", docs: "",
  defaultRoleWeight: "30", releaseBonus: "20", currentRelease: "",
  agingStepMinutes: "10", agingStepWeight: "5", agingMaxBonus: "50", starvationLimitMinutes: "90",
};

const baseProps = {
  view,
  loading: false,
  onSave: () => {},
  pending: false,
  error: null,
};

function text() {
  return container.textContent ?? "";
}

function fieldInput(id: string) {
  return container.querySelector<HTMLInputElement>(`#${id}`);
}

function sourceTag(testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function errorTag(testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

async function setInput(id: string, value: string) {
  const input = fieldInput(id);
  if (!input) throw new Error(`missing input #${id}`);
  await (async () => {
    flushSync(() => {
      // The React 19 way of driving an uncontrolled->controlled input in tests.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  })();
}

describe("parseRunPriorityDraft", () => {
  it("accepts whole numbers; an empty role weight drops the entry, other API-set roles stay", () => {
    const { patch, errors } = parseRunPriorityDraft(
      { ...emptyDraft, review: "100", release: "", lead: "40", engineer: "20", docs: "0", currentRelease: "1.6.5" },
      { release: 90, custom: 33 },
      true,
    );
    expect(errors).toEqual({});
    expect(patch).toEqual({
      enabled: true,
      roleWeights: { review: 100, lead: 40, engineer: 20, docs: 0, custom: 33 },
      defaultRoleWeight: 30,
      releaseBonus: 20,
      currentRelease: "1.6.5",
      agingStepMinutes: 10,
      agingStepWeight: 5,
      agingMaxBonus: 50,
      starvationLimitMinutes: 90,
    });
  });

  it("rejects fractions, negatives and empty numbers per field", () => {
    const { patch, errors } = parseRunPriorityDraft({
      ...emptyDraft, review: "1.5", release: "-2", agingStepMinutes: "",
    });
    expect(patch).toBeNull();
    expect(errors.review).toBe("whole-number");
    expect(errors.release).toBe("whole-number");
    expect(errors.agingStepMinutes).toBe("whole-number");
  });

  it("rejects a value past the server bound", () => {
    const { patch, errors } = parseRunPriorityDraft({ ...emptyDraft, releaseBonus: "1001", agingStepMinutes: "1441" });
    expect(patch).toBeNull();
    expect(errors.releaseBonus).toBe("range");
    expect(errors.agingStepMinutes).toBe("range");
  });

  it("treats the release line as free text and empty as off (null)", () => {
    expect(parseRunPriorityDraft({ ...emptyDraft, currentRelease: "myr-v1.6.5-rc.6" }).patch?.currentRelease).toBe(
      "myr-v1.6.5-rc.6",
    );
    expect(parseRunPriorityDraft({ ...emptyDraft, currentRelease: "  " }).patch?.currentRelease).toBeNull();
  });

  it("carries the switch into the patch", () => {
    expect(parseRunPriorityDraft(emptyDraft, {}, false).patch?.enabled).toBe(false);
  });
});

describe("RunQueuePrioritySettingsPanelView", () => {
  it("renders all five role weights, the release line, bonus, aging and the starvation limit", async () => {
    await (async () => flushSync(() => root.render(<RunQueuePrioritySettingsPanelView {...baseProps} />)))();
    expect(container.querySelector('[data-testid="myrmidon-run-queue-priority"]')).toBeTruthy();
    for (const role of ["review", "release", "lead", "engineer", "docs"]) {
      expect(fieldInput(`run-priority-role-${role}`)).toBeTruthy();
    }
    expect(fieldInput("run-priority-role-review")?.value).toBe("100");
    expect(fieldInput("run-priority-current-release")?.value).toBe("1.6.5");
    expect(fieldInput("run-priority-releaseBonus")?.value).toBe("25");
    expect(fieldInput("run-priority-agingStepMinutes")?.value).toBe("10");
    expect(fieldInput("run-priority-agingStepWeight")?.value).toBe("5");
    expect(fieldInput("run-priority-agingMaxBonus")?.value).toBe("50");
    expect(fieldInput("run-priority-starvationLimitMinutes")?.value).toBe("90");
    expect(fieldInput("run-priority-enabled")?.checked).toBe(true);
  });

  it("tells where the settings come from (saved / environment)", async () => {
    await (async () => flushSync(() => root.render(<RunQueuePrioritySettingsPanelView {...baseProps} />)))();
    expect(sourceTag("run-priority-source")).toBe("Saved here");
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView {...baseProps} view={{ ...view, source: "env" }} />,
    )))();
    expect(sourceTag("run-priority-source")).toBe("From the server environment");
  });

  it("blocks the save with a per-field error on a malformed number", async () => {
    let saved: unknown = null;
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView {...baseProps} onSave={(patch) => { saved = patch; }} />,
    )))();
    await setInput("run-priority-agingStepMinutes", "0.5");
    expect(errorTag("run-priority-error-agingStepMinutes")).toBe("Enter a whole number of 0 or more");
    const save = container.querySelector<HTMLButtonElement>("button");
    await (async () => flushSync(() => { save?.click(); }))();
    expect(saved).toBe(null);
  });

  it("sends the edited draft as the save patch and keeps the roles it does not show", async () => {
    let saved: unknown = null;
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView {...baseProps} onSave={(patch) => { saved = patch; }} />,
    )))();
    await setInput("run-priority-role-review", "120");
    const buttons = [...container.querySelectorAll("button")];
    const save = buttons[buttons.length - 1];
    await (async () => flushSync(() => { save?.click(); }))();
    expect(saved).toMatchObject({
      enabled: true,
      roleWeights: { review: 120, release: 90, lead: 40, engineer: 20, docs: 10, custom: 33 },
      releaseBonus: 25,
      currentRelease: "1.6.5",
    });
  });

  it("says the server does not expose the settings yet instead of fake inputs", async () => {
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView {...baseProps} view={null} />,
    )))();
    expect(text()).toContain("does not expose queue priority settings yet");
    expect(fieldInput("run-priority-role-review")).toBe(null);
  });

  it("shows the loading line before the first answer", async () => {
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView {...baseProps} view={undefined} loading />,
    )))();
    expect(text()).toContain("Loading the queue priority settings");
  });
});
