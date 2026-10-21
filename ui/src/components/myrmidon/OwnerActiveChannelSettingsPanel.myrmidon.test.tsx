// @vitest-environment jsdom
//
// myrmidon(1.7-ACTIVE-CHANNEL): the owner active-channel section of
// Instance → General — the threshold field, the source line, the live channel
// label and the dirty/valid gate on Save.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerActiveChannelView } from "@paperclipai/shared";
import { OwnerActiveChannelSettingsPanelView } from "./OwnerActiveChannelSettingsPanel";
import { i18n } from "@/i18n";

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

const iso = new Date(Date.now() - 60_000).toISOString();

function viewFor(overrides: Partial<OwnerActiveChannelView> = {}): OwnerActiveChannelView {
  return {
    channel: "telegram",
    lastActiveAt: { web: null, telegram: iso },
    thresholdMin: 120,
    thresholdSource: "default",
    ...overrides,
  };
}

function render(view: OwnerActiveChannelView | null, onSave = vi.fn()) {
  flushSync(() => {
    root.render(
      <OwnerActiveChannelSettingsPanelView view={view} onSave={onSave} pending={false} error={null} />,
    );
  });
  return onSave;
}

const saveButton = () =>
  [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save threshold"))!;
const threshold = () =>
  container.querySelector<HTMLInputElement>("[data-testid='owner-active-channel-threshold']")!;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("OwnerActiveChannelSettingsPanelView", () => {
  it("shows the current channel, the threshold and its source; Save disabled until something changes", () => {
    render(viewFor({ thresholdSource: "settings", thresholdMin: 45 }));
    expect(
      container.querySelector("[data-testid='owner-active-channel-current']")?.textContent,
    ).toContain("Telegram");
    expect(threshold().value).toBe("45");
    expect(threshold().disabled).toBe(false);
    expect(
      container.querySelector("[data-testid='owner-active-channel-threshold-source']")?.textContent,
    ).toContain("Saved here");
    expect(saveButton().disabled).toBe(true);
  });

  it("a forced environment threshold disables the field and names the source", () => {
    render(viewFor({ thresholdSource: "env" }));
    expect(threshold().disabled).toBe(true);
    expect(
      container.querySelector("[data-testid='owner-active-channel-threshold-source']")?.textContent,
    ).toContain("server environment");
  });

  it("saves the changed threshold only after a valid edit", () => {
    const onSave = render(viewFor());
    type(threshold(), "30");
    expect(saveButton().disabled).toBe(false);
    flushSync(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ thresholdMin: 30 });

    onSave.mockClear();
    type(threshold(), "2");
    expect(saveButton().disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the null channel renders the none label", () => {
    render(viewFor({ channel: null }));
    expect(
      container.querySelector("[data-testid='owner-active-channel-current']")?.textContent,
    ).toContain("no channel");
  });

  it("speaks the owner's language from the fork catalog", async () => {
    await i18n.changeLanguage("ru");
    try {
      render(viewFor({ channel: "web", thresholdSource: "env" }));
      expect(container.textContent).toContain("Активный канал владельца");
      expect(
        container.querySelector("[data-testid='owner-active-channel-current']")?.textContent,
      ).toContain("Портал");
      expect(
        container.querySelector("[data-testid='owner-active-channel-threshold-source']")?.textContent,
      ).toContain("Принудительно из окружения сервера");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("shows the load placeholder without a view", () => {
    render(null);
    expect(container.textContent).toContain("Loading the active-channel settings");
  });
});
