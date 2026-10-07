// myrmidon(1.7-ACTIVE-CHANNEL): the pure core of the owner active-channel
// contract — threshold precedence (env forced override > stored settings >
// default) and the active-channel decision from the last touches.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OWNER_ACTIVE_THRESHOLD_MIN,
  MAX_OWNER_ACTIVE_THRESHOLD_MIN,
  MIN_OWNER_ACTIVE_THRESHOLD_MIN,
  OWNER_ACTIVE_THRESHOLD_ENV,
  mergeOwnerActiveChannelSettings,
  normalizeOwnerActiveChannelSettings,
  parseOwnerActiveThresholdMin,
  resolveActiveOwnerChannel,
  resolveOwnerActiveChannelSettings,
} from "@paperclipai/shared";

const now = Date.parse("2026-10-05T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

describe("owner active-channel threshold settings", () => {
  it("falls back to the default when nothing is stored or set", () => {
    const resolved = resolveOwnerActiveChannelSettings({ stored: undefined, env: {} });
    expect(resolved).toEqual({
      thresholdMin: DEFAULT_OWNER_ACTIVE_THRESHOLD_MIN,
      thresholdSource: "default",
    });
  });

  it("prefers the stored settings value over the default", () => {
    const resolved = resolveOwnerActiveChannelSettings({
      stored: { thresholdMin: 30 },
      env: {},
    });
    expect(resolved).toEqual({ thresholdMin: 30, thresholdSource: "settings" });
  });

  it("the environment is a forced override over the stored value", () => {
    const resolved = resolveOwnerActiveChannelSettings({
      stored: { thresholdMin: 30 },
      env: { [OWNER_ACTIVE_THRESHOLD_ENV]: "15" },
    });
    expect(resolved).toEqual({ thresholdMin: 15, thresholdSource: "env" });
  });

  it("clamps the environment value and ignores a malformed one", () => {
    expect(parseOwnerActiveThresholdMin("1")).toBe(MIN_OWNER_ACTIVE_THRESHOLD_MIN);
    expect(parseOwnerActiveThresholdMin("999999")).toBe(MAX_OWNER_ACTIVE_THRESHOLD_MIN);
    expect(parseOwnerActiveThresholdMin("abc")).toBeNull();
    expect(parseOwnerActiveThresholdMin("-10")).toBeNull();
    expect(parseOwnerActiveThresholdMin("")).toBeNull();
    const resolved = resolveOwnerActiveChannelSettings({
      env: { [OWNER_ACTIVE_THRESHOLD_ENV]: "not-a-number" },
    });
    expect(resolved.thresholdSource).toBe("default");
  });

  it("an unusable stored row reads as absent", () => {
    expect(normalizeOwnerActiveChannelSettings({ thresholdMin: 2 })).toBeNull();
    expect(normalizeOwnerActiveChannelSettings({ unknown: 1 })).toBeNull();
    const resolved = resolveOwnerActiveChannelSettings({ stored: { thresholdMin: 2 }, env: {} });
    expect(resolved.thresholdSource).toBe("default");
  });

  it("merges a patch without dropping stored keys", () => {
    const merged = mergeOwnerActiveChannelSettings({ thresholdMin: 30 }, {});
    expect(merged).toEqual({ thresholdMin: 30 });
    expect(mergeOwnerActiveChannelSettings({ thresholdMin: 30 }, { thresholdMin: 60 })).toEqual({
      thresholdMin: 60,
    });
  });
});

describe("active-channel decision", () => {
  it("the freshest touch within the threshold wins", () => {
    expect(
      resolveActiveOwnerChannel(
        { web: iso(10), telegram: iso(2) },
        { thresholdMin: 30, now },
      ),
    ).toBe("telegram");
    expect(
      resolveActiveOwnerChannel(
        { web: iso(2), telegram: iso(10) },
        { thresholdMin: 30, now },
      ),
    ).toBe("web");
  });

  it("an owner message in Telegram makes Telegram the active channel", () => {
    // Portal activity a while back; the owner then wrote in Telegram.
    expect(
      resolveActiveOwnerChannel(
        { web: iso(45), telegram: iso(1) },
        { thresholdMin: 120, now },
      ),
    ).toBe("telegram");
  });

  it("a touch older than the threshold does not count", () => {
    expect(
      resolveActiveOwnerChannel({ web: iso(500), telegram: null }, { thresholdMin: 120, now }),
    ).toBeNull();
    expect(resolveActiveOwnerChannel({ web: null, telegram: null }, { thresholdMin: 120, now })).toBeNull();
    expect(resolveActiveOwnerChannel({}, { thresholdMin: 120, now })).toBeNull();
  });

  it("web wins a tie and a broken timestamp is ignored", () => {
    expect(resolveActiveOwnerChannel({ web: iso(5), telegram: iso(5) }, { thresholdMin: 30, now })).toBe(
      "web",
    );
    expect(resolveActiveOwnerChannel({ web: "not-a-date", telegram: iso(5) }, { thresholdMin: 30, now })).toBe(
      "telegram",
    );
  });
});
