// @vitest-environment jsdom
//
// myrmidon(1.6.5 RUN-PRIORITY B): the queue priority section of
// Instance → General — per-field sources, whole-number validation, the save
// patch shape, and the honest "not served yet" state before part A deploys.

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
    roleWeights: { review: 100, release: 90, lead: 40, engineer: 20, docs: 10 },
    currentReleaseBonus: 25,
    currentRelease: "1.6.5",
    agingStepPerHour: 2,
    agingMaxBonus: 50,
  },
  sources: { roleWeights: "settings", currentReleaseBonus: "env", currentRelease: "settings", agingStepPerHour: "default", agingMaxBonus: "default" },
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
  it("accepts whole numbers and maps empty fields to null (off)", () => {
    const { patch, errors } = parseRunPriorityDraft({
      review: "100", release: "", lead: "40", engineer: "20", docs: "0",
      currentReleaseBonus: "25", currentRelease: "1.6.5",
      agingStepPerHour: "2", agingMaxBonus: "",
    });
    expect(errors).toEqual({});
    expect(patch).toEqual({
      roleWeights: { review: 100, release: null, lead: 40, engineer: 20, docs: 0 },
      currentReleaseBonus: 25,
      currentRelease: "1.6.5",
      agingStepPerHour: 2,
      agingMaxBonus: null,
    });
  });

  it("rejects fractions and negatives per field", () => {
    const { patch, errors } = parseRunPriorityDraft({
      review: "1.5", release: "-2", lead: "", engineer: "", docs: "",
      currentReleaseBonus: "", currentRelease: "", agingStepPerHour: "", agingMaxBonus: "",
    });
    expect(patch).toBeNull();
    expect(errors.review).toBe("whole-number");
    expect(errors.release).toBe("whole-number");
  });

  it("treats the release line as free text", () => {
    const { patch, errors } = parseRunPriorityDraft({
      review: "", release: "", lead: "", engineer: "", docs: "",
      currentReleaseBonus: "", currentRelease: "myr-v1.6.5-rc.6",
      agingStepPerHour: "", agingMaxBonus: "",
    });
    expect(errors).toEqual({});
    expect(patch?.currentRelease).toBe("myr-v1.6.5-rc.6");
  });
});

describe("RunQueuePrioritySettingsPanelView", () => {
  it("renders all five role weights, the release line, bonus and aging", async () => {
    await (async () => flushSync(() => root.render(<RunQueuePrioritySettingsPanelView {...baseProps} />)))();
    expect(container.querySelector('[data-testid="myrmidon-run-queue-priority"]')).toBeTruthy();
    for (const role of ["review", "release", "lead", "engineer", "docs"]) {
      expect(fieldInput(`run-priority-role-${role}`)).toBeTruthy();
    }
    expect(fieldInput("run-priority-current-release")?.value).toBe("1.6.5");
    expect(fieldInput("run-priority-current-release-bonus")?.value).toBe("25");
    expect(fieldInput("run-priority-aging-step")?.value).toBe("2");
    expect(fieldInput("run-priority-aging-max")?.value).toBe("50");
  });

  it("tags each field with its source (saved / env / default)", async () => {
    await (async () => flushSync(() => root.render(<RunQueuePrioritySettingsPanelView {...baseProps} />)))();
    expect(sourceTag("run-priority-source-review")).toBe("Saved here");
    expect(sourceTag("run-priority-source-currentReleaseBonus")).toBe("From the server environment");
    expect(sourceTag("run-priority-source-agingStepPerHour")).toBe("Default");
  });

  it("names the whole field when roleWeights reports one source", async () => {
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView
        {...baseProps}
        view={{ ...view, sources: { ...view.sources, roleWeights: "env" } }}
      />,
    )))();
    expect(sourceTag("run-priority-source-docs")).toBe("From the server environment");
  });

  it("blocks the save with a per-field error on a malformed weight", async () => {
    let saved: unknown = null;
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView {...baseProps} onSave={(patch) => { saved = patch; }} />,
    )))();
    await setInput("run-priority-aging-step", "0.5");
    expect(errorTag("run-priority-error-agingStepPerHour")).toBe("Enter a whole number of 0 or more, or leave it empty");
    const save = container.querySelector<HTMLButtonElement>("button");
    await (async () => flushSync(() => { save?.click(); }))();
    expect(saved).toBe(null);
  });

  it("sends the edited draft as the save patch", async () => {
    let saved: unknown = null;
    await (async () => flushSync(() => root.render(
      <RunQueuePrioritySettingsPanelView {...baseProps} onSave={(patch) => { saved = patch; }} />,
    )))();
    await setInput("run-priority-role-review", "120");
    const buttons = [...container.querySelectorAll("button")];
    const save = buttons[buttons.length - 1];
    await (async () => flushSync(() => { save?.click(); }))();
    expect(saved).toMatchObject({ roleWeights: { review: 120, release: 90, lead: 40, engineer: 20, docs: 10 } });
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
