// myrmidon(1.7-ACTIVE-CHANNEL): unit tests for active-channel freshness formatting
// and label composition across languages and channel states.

import { describe, expect, it } from "vitest";
import {
  formatOwnerActiveChannelFreshness,
  formatOwnerActiveChannelLabel,
  type Ui2OwnerActiveChannel,
} from "./useOwnerActiveChannel";

describe("formatOwnerActiveChannelFreshness", () => {
  const fixedNow = 1_700_000_000_000;

  it("returns null when timestamp is missing or unparseable", () => {
    expect(formatOwnerActiveChannelFreshness(null)).toBeNull();
    expect(formatOwnerActiveChannelFreshness(undefined)).toBeNull();
    expect(formatOwnerActiveChannelFreshness("not-a-date")).toBeNull();
  });

  it("formats recent activity under 1 minute as just now", () => {
    const at = new Date(fixedNow - 30_000).toISOString();
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "en" })).toBe("just now");
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "ru" })).toBe("только что");
  });

  it("formats relative minutes in en and ru", () => {
    const at = new Date(fixedNow - 5 * 60_000).toISOString();
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "en" })).toBe("5 minutes ago");
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "ru" })).toBe("5 минут назад");
  });

  it("formats relative hours", () => {
    const at = new Date(fixedNow - 2 * 3600_000).toISOString();
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "en" })).toBe("2 hours ago");
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "ru" })).toBe("2 часа назад");
  });

  it("formats relative days", () => {
    const at = new Date(fixedNow - 3 * 86400_000).toISOString();
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "en" })).toBe("3 days ago");
    expect(formatOwnerActiveChannelFreshness(at, { now: fixedNow, locale: "ru" })).toBe("3 дня назад");
  });
});

describe("formatOwnerActiveChannelLabel", () => {
  const fixedNow = 1_700_000_000_000;

  const mockEnT = (key: string, opts?: { defaultValue?: string }) => {
    const dict: Record<string, string> = {
      "ui2.shell.activeChannel.web": "Active · Web",
      "ui2.shell.activeChannel.telegram": "Active · Telegram",
      "ui2.shell.activeChannel.none": "Active · not seen recently",
      "time.justNow": "just now",
    };
    return dict[key] ?? opts?.defaultValue ?? key;
  };

  const mockRuT = (key: string, opts?: { defaultValue?: string }) => {
    const dict: Record<string, string> = {
      "ui2.shell.activeChannel.web": "Активен · Веб",
      "ui2.shell.activeChannel.telegram": "Активен · Telegram",
      "ui2.shell.activeChannel.none": "Давно не появлялся",
      "time.justNow": "только что",
    };
    return dict[key] ?? opts?.defaultValue ?? key;
  };

  it("renders not-seen label when channel is null", () => {
    const activeChannel: Ui2OwnerActiveChannel = { channel: null, lastActiveAt: null };
    expect(formatOwnerActiveChannelLabel(activeChannel, mockEnT, { locale: "en" })).toBe(
      "Active · not seen recently",
    );
    expect(formatOwnerActiveChannelLabel(activeChannel, mockRuT, { locale: "ru" })).toBe(
      "Давно не появлялся",
    );
  });

  it("renders channel with freshness when recent activity is present", () => {
    const fiveMinutesAgo = new Date(fixedNow - 5 * 60_000).toISOString();

    const webChannel: Ui2OwnerActiveChannel = { channel: "web", lastActiveAt: fiveMinutesAgo };
    expect(
      formatOwnerActiveChannelLabel(webChannel, mockEnT, { locale: "en", now: fixedNow }),
    ).toBe("Active · Web · 5 minutes ago");
    expect(
      formatOwnerActiveChannelLabel(webChannel, mockRuT, { locale: "ru", now: fixedNow }),
    ).toBe("Активен · Веб · 5 минут назад");

    const tgChannel: Ui2OwnerActiveChannel = { channel: "telegram", lastActiveAt: fiveMinutesAgo };
    expect(
      formatOwnerActiveChannelLabel(tgChannel, mockEnT, { locale: "en", now: fixedNow }),
    ).toBe("Active · Telegram · 5 minutes ago");
  });

  it("renders bare channel label when lastActiveAt is absent", () => {
    const webChannel: Ui2OwnerActiveChannel = { channel: "web", lastActiveAt: null };
    expect(formatOwnerActiveChannelLabel(webChannel, mockEnT, { locale: "en" })).toBe(
      "Active · Web",
    );
  });
});
