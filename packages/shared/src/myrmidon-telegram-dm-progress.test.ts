import { describe, expect, it } from "vitest";
import {
  mergeTelegramDmProgressSettings,
  parseTelegramDmProgressInterval,
  patchTelegramDmProgressSchema,
  resolveTelegramDmProgress,
} from "./myrmidon-telegram-dm-progress.js";

describe("resolveTelegramDmProgress", () => {
  it("defaults to off, 45 s, when nothing is set", () => {
    expect(resolveTelegramDmProgress()).toEqual({
      enabled: false,
      enabledSource: "default",
      intervalSec: 45,
      intervalSource: "default",
    });
  });

  it("the default of enabled follows the status-message switch", () => {
    const resolved = resolveTelegramDmProgress({ env: { MYRMIDON_TELEGRAM_DM_STATUS: "1" } });
    expect(resolved.enabled).toBe(true);
    expect(resolved.enabledSource).toBe("default");
  });

  it("stored settings beat the default, the environment beats stored settings", () => {
    const stored = { enabled: true, intervalSec: 60 };
    expect(resolveTelegramDmProgress({ stored })).toMatchObject({
      enabled: true,
      enabledSource: "settings",
      intervalSec: 60,
      intervalSource: "settings",
    });
    expect(
      resolveTelegramDmProgress({
        stored,
        env: { MYRMIDON_TELEGRAM_DM_PROGRESS: "off", MYRMIDON_TELEGRAM_DM_PROGRESS_INTERVAL_SEC: "120" },
      }),
    ).toMatchObject({ enabled: false, enabledSource: "env", intervalSec: 120, intervalSource: "env" });
  });

  it("clamps an environment interval and ignores unreadable values", () => {
    expect(parseTelegramDmProgressInterval("1")).toBe(15);
    expect(parseTelegramDmProgressInterval("99999")).toBe(300);
    expect(parseTelegramDmProgressInterval("soon")).toBeNull();
    expect(parseTelegramDmProgressInterval("")).toBeNull();
  });

  it("a malformed stored value reads as unset", () => {
    expect(resolveTelegramDmProgress({ stored: { intervalSec: 1 } })).toMatchObject({
      intervalSec: 45,
      intervalSource: "default",
    });
  });
});

describe("patch and merge", () => {
  it("rejects out-of-range intervals and unknown keys", () => {
    expect(patchTelegramDmProgressSchema.safeParse({ intervalSec: 5 }).success).toBe(false);
    expect(patchTelegramDmProgressSchema.safeParse({ intervalSec: 301 }).success).toBe(false);
    expect(patchTelegramDmProgressSchema.safeParse({ other: 1 }).success).toBe(false);
    expect(patchTelegramDmProgressSchema.safeParse({ enabled: true, intervalSec: 30 }).success).toBe(true);
  });

  it("changes only the given fields", () => {
    expect(mergeTelegramDmProgressSettings({ enabled: true, intervalSec: 60 }, { intervalSec: 30 })).toEqual({
      enabled: true,
      intervalSec: 30,
    });
    expect(mergeTelegramDmProgressSettings(undefined, { enabled: false })).toEqual({ enabled: false });
  });
});
