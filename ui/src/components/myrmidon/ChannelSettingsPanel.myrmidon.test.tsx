// @vitest-environment jsdom
//
// myrmidon(SETTINGS-UI A): the "Channels (Telegram & chat bridges)" panel —
// the draft parse (positive ceilings, zero-allowed counters, the nullable
// reconcile interval), the save path, the environment-pinned keys dropped from
// the patch and read-only, and the deployment-only base URL line. Neutral data
// only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelSettingsPanelView,
  parseChannelSettingsDraft,
} from "./ChannelSettingsPanel";
import type { ChannelSettingValue, ChannelSettingsView } from "./channelSettingsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function resolved<T>(value: T, over: Partial<ChannelSettingValue<T>> = {}): ChannelSettingValue<T> {
  return { value, source: "default", default: value, envName: "SOME_ENV", overridden: false, ...over };
}

const VIEW: ChannelSettingsView = {
  telegramDmConversations: resolved("chat-1, chat-2"),
  telegramDmStatus: resolved(true, { source: "ui", default: false, envName: "MYRMIDON_TELEGRAM_DM_STATUS" }),
  telegramSplitMaxParts: resolved(4),
  telegramFileLimitBytes: resolved(50331648),
  paperclipAttachmentMaxBytes: resolved(10485760),
  chatCrossChannelMessages: resolved(12),
  chatCrossChannelMessageChars: resolved(600),
  chatCrossChannelTotalChars: resolved(4000),
  chatCrossChannelLookbackHours: resolved(168),
  chatReconcileIntervalMs: resolved(null),
  telegramApiBaseUrl: resolved("https://api.telegram.org", {
    source: "env",
    default: null,
    envName: "TELEGRAM_API_BASE_URL",
    overridden: true,
  }),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderView(overrides: Partial<Parameters<typeof ChannelSettingsPanelView>[0]> = {}) {
  const onSave = vi.fn();
  act(() => {
    root.render(
      <ChannelSettingsPanelView view={VIEW} onSave={onSave} pending={false} error={null} {...overrides} />,
    );
  });
  return { onSave };
}

function input(id: string) {
  return container.querySelector<HTMLInputElement>(`#${id}`)!;
}

function setText(id: string, value: string) {
  const el = input(id);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function save() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save channel settings"),
  )!;
  act(() => button.click());
}

const DRAFT = {
  telegramDmConversations: "",
  telegramSplitMaxParts: "4",
  telegramFileLimitBytes: "50331648",
  paperclipAttachmentMaxBytes: "10485760",
  chatCrossChannelMessages: "12",
  chatCrossChannelMessageChars: "600",
  chatCrossChannelTotalChars: "4000",
  chatCrossChannelLookbackHours: "168",
  chatReconcileIntervalMs: "",
};

describe("parseChannelSettingsDraft", () => {
  it("carries the document fields, null for an empty reconcile interval", () => {
    const { patch, errors } = parseChannelSettingsDraft(DRAFT);
    expect(errors).toEqual({});
    expect(patch.chatReconcileIntervalMs).toBeNull();
    expect(patch.telegramFileLimitBytes).toBe(50331648);
    expect(patch.telegramDmConversations).toBe("");
  });

  it("allows 0 as the documented off-state of the counters", () => {
    const { patch, errors } = parseChannelSettingsDraft({
      ...DRAFT,
      chatCrossChannelMessages: "0",
      telegramSplitMaxParts: "0",
    });
    expect(errors).toEqual({});
    expect(patch.chatCrossChannelMessages).toBe(0);
  });

  it("refuses zero and fractions for the file ceilings", () => {
    const { patch, errors } = parseChannelSettingsDraft({
      ...DRAFT,
      telegramFileLimitBytes: "0",
      paperclipAttachmentMaxBytes: "1.5",
    });
    expect(patch.telegramFileLimitBytes).toBeUndefined();
    expect(errors.telegramFileLimitBytes).toBeTruthy();
    expect(errors.paperclipAttachmentMaxBytes).toBeTruthy();
  });

  it("refuses a non-positive reconcile interval, an empty field stays the standard pace", () => {
    const bad = parseChannelSettingsDraft({ ...DRAFT, chatReconcileIntervalMs: "-5" });
    expect(bad.errors.chatReconcileIntervalMs).toBeTruthy();
    const good = parseChannelSettingsDraft({ ...DRAFT, chatReconcileIntervalMs: "60000" });
    expect(good.patch.chatReconcileIntervalMs).toBe(60000);
  });
});

describe("ChannelSettingsPanelView", () => {
  it("renders the effective values, sources and the deployment-only base URL", () => {
    renderView();
    expect(input("channel-settings-telegramDmConversations").value).toBe("chat-1, chat-2");
    expect(input("channel-settings-telegramFileLimitBytes").value).toBe("50331648");
    expect(input("channel-settings-chatReconcileIntervalMs").value).toBe("");
    expect(
      container.querySelector("[data-testid='channel-settings-source-telegramDmStatus']")!.textContent,
    ).toBe("Saved here");
    const deployment = container.querySelector("[data-testid='channel-settings-telegramApiBaseUrl']")!;
    expect(deployment.textContent).toBe("https://api.telegram.org");
  });

  it("keeps an environment-pinned key read-only and out of the saved patch", () => {
    const pinned: ChannelSettingsView = {
      ...VIEW,
      telegramSplitMaxParts: resolved(9, { source: "env", overridden: true, envName: "MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS" }),
    };
    const { onSave } = renderView({ view: pinned });
    expect(input("channel-settings-telegramSplitMaxParts").disabled).toBe(true);
    setText("channel-settings-telegramFileLimitBytes", "20971520");
    save();
    const patch = onSave.mock.calls[0][0];
    expect(patch.telegramFileLimitBytes).toBe(20971520);
    expect(patch.telegramSplitMaxParts).toBeUndefined();
  });

  it("saves the boolean switch alongside the numbers", () => {
    const { onSave } = renderView();
    const toggle = container.querySelector(
      "[data-testid='channel-settings-telegramDmStatus-toggle']",
    ) as unknown as { click(): void };
    act(() => toggle.click());
    save();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ telegramDmStatus: false }),
    );
  });

  it("refuses to save a malformed number and names the field", () => {
    const { onSave } = renderView();
    setText("channel-settings-chatCrossChannelMessages", "twelve");
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='channel-settings-error-chatCrossChannelMessages']")!
        .textContent,
    ).toBeTruthy();
  });
});
