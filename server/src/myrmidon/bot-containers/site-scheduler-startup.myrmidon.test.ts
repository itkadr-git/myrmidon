import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { BOT_CONTAINERS_ENV } from "./agent-config.js";
import {
  isSiteSchedulerEnabled,
  SITE_SCHEDULER_ENV,
  startSiteScheduler,
} from "./site-scheduler-startup.js";
import * as fleetMoveWiring from "./fleet-move-wiring.js";
import * as laneModule from "./site-scheduler-lane.js";
import type { FleetClientManager } from "./site-registry.js";

const DB = { marker: "db" } as unknown as Db;
const mockManager = (): FleetClientManager => ({
  getClients: () => new Map(),
  getTransports: () => new Map(),
  refresh: async () => new Map(),
  getVersion: () => 1,
  ensureFresh: vi.fn(async () => {}),
  close: () => {},
});

describe("isSiteSchedulerEnabled", () => {
  it("needs both the container runtime and its own flag", () => {
    expect(isSiteSchedulerEnabled({})).toBe(false);
    expect(isSiteSchedulerEnabled({ [BOT_CONTAINERS_ENV]: "1" })).toBe(false);
    expect(isSiteSchedulerEnabled({ [SITE_SCHEDULER_ENV]: "1" })).toBe(false);
    expect(isSiteSchedulerEnabled({ [BOT_CONTAINERS_ENV]: "1", [SITE_SCHEDULER_ENV]: "0" })).toBe(false);
    expect(isSiteSchedulerEnabled({ [BOT_CONTAINERS_ENV]: "1", [SITE_SCHEDULER_ENV]: "1" })).toBe(true);
  });
});

describe("startSiteScheduler", () => {
  it("returns no-op when disabled", () => {
    const stop = startSiteScheduler(DB, { env: {} });
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("passes clientManager closure to createFleetMoveContext when enabled", () => {
    const spy = vi.spyOn(fleetMoveWiring, "createFleetMoveContext").mockReturnValue({} as any);
    const laneSpy = vi.spyOn(laneModule, "startSiteSchedulerLane").mockReturnValue(() => {});

    const m = mockManager();
    const env = { [BOT_CONTAINERS_ENV]: "1", [SITE_SCHEDULER_ENV]: "1" };
    const stop = startSiteScheduler(DB, { env, clientManager: m });

    expect(spy).toHaveBeenCalledWith(DB, expect.any(Function));
    const passedFn = spy.mock.calls[0][1] as () => FleetClientManager | null;
    expect(passedFn()).toBe(m);

    expect(laneSpy).toHaveBeenCalled();
    stop();

    spy.mockRestore();
    laneSpy.mockRestore();
  });
});
