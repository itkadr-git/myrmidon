// @vitest-environment jsdom
//
// myrmidon(PAUSE-GUARD): the "Forgotten pauses" section of Instance → General,
// next to the Run limits. The draft parser is what decides whether a save is
// allowed, so it is exercised on its own; the view is rendered once to prove
// the five fields exist and carry the saved values.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PauseGuardSettingKey, PauseGuardSettingsSource } from "@paperclipai/shared";
import type { PauseGuardView } from "./pauseGuardApi";
import {
  PauseGuardSettingsPanelView,
  parsePauseGuardDraft,
  toPauseGuardDraft,
  type PauseGuardDraft,
} from "./PauseGuardSettingsPanel";

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

const view: PauseGuardView = {
  settings: {
    enabled: true,
    thresholdMinutes: 20,
    intervalSec: 600,
    allowlist: ["agent-maint"],
    maxResumesPerPass: 20,
  },
  sources: {
    enabled: "default",
    thresholdMinutes: "env",
    intervalSec: "default",
    allowlist: "settings",
    maxResumesPerPass: "settings",
  } satisfies Record<PauseGuardSettingKey, PauseGuardSettingsSource>,
};

function draft(overrides: Partial<PauseGuardDraft> = {}): PauseGuardDraft {
  return { ...toPauseGuardDraft(view.settings), ...overrides };
}

describe("pause guard settings draft", () => {
  it("keeps the saved values in the draft", () => {
    expect(toPauseGuardDraft(view.settings)).toEqual({
      enabled: true,
      thresholdMinutes: "20",
      intervalSec: "600",
      allowlist: "agent-maint",
      maxResumesPerPass: "20",
    });
  });

  it("parses a valid draft into the API patch", () => {
    const parsed = parsePauseGuardDraft(draft({ allowlist: "agent-a, agent-b\nagent-a" }));
    expect(parsed.errors).toEqual({});
    expect(parsed.patch).toEqual({
      enabled: true,
      thresholdMinutes: 20,
      intervalSec: 600,
      allowlist: ["agent-a", "agent-b"],
      maxResumesPerPass: 20,
    });
  });

  it("rejects a number outside its bounds instead of clamping it", () => {
    expect(parsePauseGuardDraft(draft({ thresholdMinutes: "0" })).patch).toBeNull();
    expect(parsePauseGuardDraft(draft({ thresholdMinutes: "2000" })).errors.thresholdMinutes).toBeTruthy();
    expect(parsePauseGuardDraft(draft({ intervalSec: "5" })).errors.intervalSec).toBeTruthy();
    expect(parsePauseGuardDraft(draft({ maxResumesPerPass: "" })).errors.maxResumesPerPass).toBeTruthy();
  });

  it("carries the off switch through as a boolean", () => {
    expect(parsePauseGuardDraft(draft({ enabled: false })).patch?.enabled).toBe(false);
  });
});

describe("pause guard settings view", () => {
  it("renders the five fields with the saved values", () => {
    flushSync(() => {
      root.render(
        <PauseGuardSettingsPanelView view={view} onSave={() => {}} pending={false} error={null} />,
      );
    });
    const section = container.querySelector('[data-testid="myrmidon-pause-guard"]');
    expect(section).toBeTruthy();
    expect((section!.querySelector("#pause-guard-threshold") as HTMLInputElement).value).toBe("20");
    expect((section!.querySelector("#pause-guard-interval") as HTMLInputElement).value).toBe("600");
    expect((section!.querySelector("#pause-guard-max") as HTMLInputElement).value).toBe("20");
    expect((section!.querySelector("#pause-guard-allowlist") as HTMLTextAreaElement).value).toBe("agent-maint");
    expect(section!.querySelector('[data-testid="pause-guard-source-thresholdMinutes"]')?.textContent).toBe(
      "From the server environment",
    );
  });

  it("says so while it has no settings yet", () => {
    flushSync(() => {
      root.render(<PauseGuardSettingsPanelView view={null} onSave={() => {}} pending={false} error={null} />);
    });
    expect(container.textContent).toContain("Loading pause guard settings");
  });
});