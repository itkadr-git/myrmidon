// A lost NOTIFY heals itself: the periodic re-read and the reconnect re-read
// put the stored run priority settings in force without any PATCH.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { normalizeRunPrioritySettings } from "@myrmidon/shared";

const getGeneral = vi.hoisted(() => vi.fn());
vi.mock("../../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getGeneral }) }));

import { currentRunPrioritySettings, resetRunPriorityForTests } from "./state.js";
import { startRunPriorityRefresh } from "./sync.js";
import { registerSettingsAppliers } from "../settings-appliers/index.js";

const updated: unknown[] = [];
let companySettings: Record<string, unknown> = {};
const db = {
  execute: async () => undefined,
  select: () => ({ from: () => ({ where: async () => [{ general: { behaviorSettingsByCompany: companySettings } }] }) }),
  update: () => ({ set: (v: unknown) => ({ where: () => ({ returning: async () => { updated.push(v); return []; } }) }) }),
} as unknown as Db;

describe("run priority self-healing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRunPriorityForTests();
    updated.length = 0;
    companySettings = {};
    getGeneral.mockReset().mockResolvedValue({
      runPriority: normalizeRunPrioritySettings({ currentRelease: "1.6.9", strictReleaseFocus: true }),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetRunPriorityForTests();
  });

  it("the periodic refresh picks up a row changed without any notice, and stops on request", async () => {
    const stop = startRunPriorityRefresh(db, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(currentRunPrioritySettings().currentRelease).toBe("1.6.9");
    expect(currentRunPrioritySettings().strictReleaseFocus).toBe(true);
    // The row changes; no NOTIFY arrives.
    getGeneral.mockResolvedValue({
      runPriority: normalizeRunPrioritySettings({ currentRelease: "1.6.9", strictReleaseFocus: false }),
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(currentRunPrioritySettings().strictReleaseFocus).toBe(false);
    // Focus was lifted: the deferred runs were advanced.
    expect(updated.length).toBeGreaterThan(0);
    stop();
    getGeneral.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGeneral).not.toHaveBeenCalled();
  });

  it("a failed refresh is survived and the next one applies", async () => {
    const stop = startRunPriorityRefresh(db, 1000);
    getGeneral.mockRejectedValueOnce(new Error("db down"));
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(1100);
    expect(currentRunPrioritySettings().currentRelease).toBe("1.6.9");
    stop();
  });

  it("advances deferred runs when a company focus changes without a notification", async () => {
    const stop = startRunPriorityRefresh(db, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    updated.length = 0;
    companySettings = { companyA: { releaseFocus: { currentRelease: "1.7", strictReleaseFocus: true } } };
    await vi.advanceTimersByTimeAsync(1100);
    expect(updated.length).toBeGreaterThan(0);
    stop();
  });

  it("a bus reconnect re-reads the stored settings; a failing apply is logged and does not stop the chain", async () => {
    let reconnect: (() => void) | null = null;
    const bus = {
      subscribe: () => () => undefined,
      onReconnect: (handler: () => void) => {
        reconnect = handler;
        return () => undefined;
      },
    };
    registerSettingsAppliers(bus, { db });
    getGeneral.mockRejectedValueOnce(new Error("db down"));
    reconnect!();
    await vi.advanceTimersByTimeAsync(10);
    expect(currentRunPrioritySettings().currentRelease).not.toBe("1.6.9");
    reconnect!();
    await vi.advanceTimersByTimeAsync(10);
    expect(currentRunPrioritySettings().currentRelease).toBe("1.6.9");
  });
});
