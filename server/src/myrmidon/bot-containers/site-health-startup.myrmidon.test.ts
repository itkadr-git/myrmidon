import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { BOT_CONTAINERS_ENV } from "./agent-config.js";
import {
  isSiteHealthEnabled,
  registerSiteLostRunFinalizer,
  SITE_HEALTH_ENV,
  startSiteHealth,
} from "./site-health-startup.js";
import type { FleetClientManager } from "./site-registry.js";

const DB = { marker: "db" } as unknown as Db;
const manager = (): FleetClientManager & { ensureFresh: ReturnType<typeof vi.fn> } => ({
  getClients: () => new Map(),
  getTransports: () => new Map(),
  refresh: async () => new Map(),
  getVersion: () => 1,
  ensureFresh: vi.fn(async () => {}),
  close: () => {},
});

afterEach(() => registerSiteLostRunFinalizer(null));

describe("isSiteHealthEnabled", () => {
  it("needs both the container runtime and its own flag", () => {
    expect(isSiteHealthEnabled({})).toBe(false);
    expect(isSiteHealthEnabled({ [BOT_CONTAINERS_ENV]: "1" })).toBe(false);
    expect(isSiteHealthEnabled({ [SITE_HEALTH_ENV]: "1" })).toBe(false);
    expect(isSiteHealthEnabled({ [BOT_CONTAINERS_ENV]: "1", [SITE_HEALTH_ENV]: "0" })).toBe(false);
    expect(isSiteHealthEnabled({ [BOT_CONTAINERS_ENV]: "1", [SITE_HEALTH_ENV]: "1" })).toBe(true);
  });
});

describe("startSiteHealth", () => {
  it("reads and starts nothing when the flag is off", () => {
    registerSiteLostRunFinalizer(async () => ({ outcome: "finalized", retryRunId: null }));
    const m = manager();
    const stop = startSiteHealth(DB, { env: { [BOT_CONTAINERS_ENV]: "1" }, clientManager: m });
    expect(m.ensureFresh).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("does not start in a process that has no heartbeat service to finalize runs with", () => {
    registerSiteLostRunFinalizer(null);
    const m = manager();
    const stop = startSiteHealth(DB, { env: { [BOT_CONTAINERS_ENV]: "1", [SITE_HEALTH_ENV]: "1" }, clientManager: m });
    expect(() => stop()).not.toThrow();
    expect(m.ensureFresh).not.toHaveBeenCalled();
  });

  it("starts with the flag and a finalizer, and its stop clears the timers", () => {
    vi.useFakeTimers();
    try {
      registerSiteLostRunFinalizer(async () => ({ outcome: "finalized", retryRunId: null }));
      const stop = startSiteHealth(DB, {
        env: { [BOT_CONTAINERS_ENV]: "1", [SITE_HEALTH_ENV]: "1" },
        clientManager: manager(),
      });
      expect(vi.getTimerCount()).toBe(1);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
