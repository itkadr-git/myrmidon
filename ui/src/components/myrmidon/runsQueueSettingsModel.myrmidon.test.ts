// myrmidon(1.6.7 SETTINGS-GENERAL-CRASH): the Runs & Queue tab read a
// `values[]` array from GET /api/myrmidon/behavior-settings while the server
// answers `{ settings, sources }`; opening Settings -> General threw
// "values is not iterable" and the page fell to the error screen. These tests
// pin the contract the tab reads (the body below is the shape the server sends,
// see server/src/myrmidon/behavior-settings/routes.ts and
// behavior-settings.myrmidon.test.ts) and that an unexpected body never throws.

import { describe, expect, it } from "vitest";
import { behaviorSettingRegistry } from "@myrmidon/shared";
import {
  formatRunsQueueValue,
  inferValueType,
  parseRunsQueueInput,
  readRunsQueueItems,
  RUNS_QUEUE_KEYS,
  runsQueueValueChanged,
} from "./runsQueueSettingsModel";

/** The response of GET /myrmidon/behavior-settings: every behavior key plus where its value came from. */
const SERVED = {
  settings: {
    debug_mode: false,
    "runsQueue.idlePickup.wakeBatch": 5,
    "runsQueue.idlePickup.enabled": true,
    "runsQueue.idlePickup.recentSuccessWindowMs": 1800000,
    "runsQueue.autoResume.backoffMs": [60000, 300000, 900000],
    "runsQueue.infraInterrupt.codes": ["agent_paused", "process_lost"],
    "runsQueue.swarm.pilotBaselineDoc": "baseline-snapshot-14d",
    "runsQueue.dbBackup.catchupWindow": "",
  },
  sources: {
    debug_mode: "default",
    "runsQueue.idlePickup.wakeBatch": "default",
    "runsQueue.idlePickup.enabled": "ui",
    "runsQueue.idlePickup.recentSuccessWindowMs": "env",
    "runsQueue.autoResume.backoffMs": "default",
    "runsQueue.infraInterrupt.codes": "default",
    "runsQueue.swarm.pilotBaselineDoc": "default",
    "runsQueue.dbBackup.catchupWindow": "default",
  },
};

describe("Runs & Queue tab: reading the behavior-settings response", () => {
  it("reads the { settings, sources } body in the tab's key order, skipping other sections", () => {
    const items = readRunsQueueItems(SERVED);
    expect(items?.map((item) => item.key)).toEqual([
      "runsQueue.idlePickup.wakeBatch",
      "runsQueue.idlePickup.enabled",
      "runsQueue.idlePickup.recentSuccessWindowMs",
      "runsQueue.autoResume.backoffMs",
      "runsQueue.infraInterrupt.codes",
      "runsQueue.swarm.pilotBaselineDoc",
      "runsQueue.dbBackup.catchupWindow",
    ]);
  });

  it("carries the value, the source and the control type of each setting", () => {
    const byKey = Object.fromEntries((readRunsQueueItems(SERVED) ?? []).map((item) => [item.key, item]));
    expect(byKey["runsQueue.idlePickup.wakeBatch"]).toEqual({
      key: "runsQueue.idlePickup.wakeBatch",
      value: 5,
      source: "default",
      valueType: "number",
    });
    expect(byKey["runsQueue.idlePickup.enabled"]).toMatchObject({ value: true, source: "ui", valueType: "boolean" });
    expect(byKey["runsQueue.idlePickup.recentSuccessWindowMs"].source).toBe("env");
    expect(byKey["runsQueue.autoResume.backoffMs"].valueType).toBe("json");
    expect(byKey["runsQueue.dbBackup.catchupWindow"]).toMatchObject({ value: "", valueType: "string" });
  });

  it("treats a missing or unknown source as the default", () => {
    const items = readRunsQueueItems({ settings: { "runsQueue.idlePickup.wakeBatch": 5 } });
    expect(items?.[0].source).toBe("default");
    const odd = readRunsQueueItems({
      settings: { "runsQueue.idlePickup.wakeBatch": 5 },
      sources: { "runsQueue.idlePickup.wakeBatch": "settings" },
    });
    expect(odd?.[0].source).toBe("default");
  });

  it("leaves out a key an older server does not serve", () => {
    expect(readRunsQueueItems({ settings: { debug_mode: true }, sources: {} })).toEqual([]);
  });

  it("answers null, without throwing, for a body that is not { settings, sources }", () => {
    const bodies: unknown[] = [
      undefined,
      null,
      [],
      "settings",
      5,
      {},
      { values: [] },
      { values: [{ key: "runsQueue.idlePickup.enabled", value: true }] },
      { settings: null },
      { settings: [] },
      { settings: "x", sources: {} },
    ];
    for (const body of bodies) {
      expect(() => readRunsQueueItems(body)).not.toThrow();
      expect(readRunsQueueItems(body)).toBeNull();
    }
  });

  it("tolerates a malformed sources member", () => {
    const body = { settings: { "runsQueue.idlePickup.enabled": true }, sources: null };
    expect(readRunsQueueItems(body)?.[0]).toMatchObject({ value: true, source: "default" });
  });
});

describe("Runs & Queue tab: the key list matches the shared registry", () => {
  it("lists only registered runs-queue keys, with the control type their value implies", () => {
    for (const key of RUNS_QUEUE_KEYS) {
      const def = behaviorSettingRegistry.get(key);
      expect(def, key).toBeDefined();
      expect(def?.section, key).toBe("runs-queue");
      expect(inferValueType(def?.default), key).toBe(def?.valueType);
    }
  });

  it("lists every runs-queue key the registry has", () => {
    const registered = behaviorSettingRegistry
      .getAll()
      .filter((def) => def.section === "runs-queue")
      .map((def) => def.key)
      .sort();
    expect([...RUNS_QUEUE_KEYS].sort()).toEqual(registered);
  });
});

describe("Runs & Queue tab: values typed into a field", () => {
  const number = { key: "runsQueue.idlePickup.wakeBatch", valueType: "number" } as const;
  const backoff = { key: "runsQueue.autoResume.backoffMs", valueType: "json" } as const;
  const codes = { key: "runsQueue.infraInterrupt.codes", valueType: "json" } as const;
  const text = { key: "runsQueue.dbBackup.catchupWindow", valueType: "string" } as const;

  it("parses a number and refuses blank or non-numeric text", () => {
    expect(parseRunsQueueInput(number, " 8 ")).toEqual({ ok: true, value: 8 });
    expect(parseRunsQueueInput(number, "")).toEqual({ ok: false });
    expect(parseRunsQueueInput(number, "abc")).toEqual({ ok: false });
  });

  it("parses the back-off list into numbers and the codes list into strings", () => {
    expect(parseRunsQueueInput(backoff, "1000, 2000,3000")).toEqual({ ok: true, value: [1000, 2000, 3000] });
    expect(parseRunsQueueInput(backoff, "1000, soon")).toEqual({ ok: false });
    expect(parseRunsQueueInput(backoff, " , ")).toEqual({ ok: false });
    expect(parseRunsQueueInput(codes, "agent_paused, process_lost")).toEqual({
      ok: true,
      value: ["agent_paused", "process_lost"],
    });
  });

  it("sends a plain string as typed, so an empty catch-up window can switch the feature off", () => {
    expect(parseRunsQueueInput(text, "")).toEqual({ ok: true, value: "" });
    expect(parseRunsQueueInput(text, "Europe/Moscow 03:00-05:00")).toEqual({
      ok: true,
      value: "Europe/Moscow 03:00-05:00",
    });
  });

  it("formats a list for the input and detects a real change", () => {
    expect(formatRunsQueueValue([60000, 300000])).toBe("60000, 300000");
    expect(formatRunsQueueValue(null)).toBe("");
    expect(runsQueueValueChanged([1, 2], [1, 2])).toBe(false);
    expect(runsQueueValueChanged([1, 2], [1, 3])).toBe(true);
    expect(runsQueueValueChanged(5, 5)).toBe(false);
  });
});
