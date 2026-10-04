// @vitest-environment jsdom
//
// myrmidon(DM-PROGRESS): the live-progress section of Instance → General — the
// toggle, the interval field, the source lines and the dirty/valid gate on Save.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramDmProgressView } from "./telegramDmProgressApi";
import { TelegramDmProgressSettingsPanelView } from "./TelegramDmProgressSettingsPanel";

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

const view: TelegramDmProgressView = {
  enabled: false,
  enabledSource: "default",
  intervalSec: 45,
  intervalSource: "default",
};

function render(value: TelegramDmProgressView | null, onSave = vi.fn()) {
  flushSync(() => {
    root.render(<TelegramDmProgressSettingsPanelView view={value} onSave={onSave} pending={false} error={null} />);
  });
  return onSave;
}

const saveButton = () =>
  [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save live progress"))!;
const toggle = () => container.querySelector<HTMLButtonElement>("[data-testid='telegram-dm-progress-enabled']")!;
const interval = () => container.querySelector<HTMLInputElement>("[data-testid='telegram-dm-progress-interval']")!;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("TelegramDmProgressSettingsPanelView", () => {
  it("shows the effective values and their sources, Save disabled until something changes", () => {
    render({ enabled: true, enabledSource: "settings", intervalSec: 60, intervalSource: "env" });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(interval().value).toBe("60");
    expect(interval().disabled).toBe(true);
    expect(container.querySelector("[data-testid='telegram-dm-progress-enabled-source']")?.textContent).toBe(
      "Saved here",
    );
    expect(saveButton().disabled).toBe(true);
  });

  it("saves only the changed fields", () => {
    const onSave = render(view);
    flushSync(() => toggle().click());
    expect(saveButton().disabled).toBe(false);
    flushSync(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ enabled: true });

    type(interval(), "90");
    flushSync(() => saveButton().click());
    expect(onSave).toHaveBeenLastCalledWith({ enabled: true, intervalSec: 90 });
  });

  it("blocks Save for an interval outside the allowed bounds", () => {
    render(view);
    type(interval(), "5");
    expect(saveButton().disabled).toBe(true);
    type(interval(), "abc");
    expect(saveButton().disabled).toBe(true);
    type(interval(), "30");
    expect(saveButton().disabled).toBe(false);
  });

  it("shows the load placeholder without a view", () => {
    render(null);
    expect(container.textContent).toContain("Loading the live progress settings");
  });
});
