// myrmidon(1.6.6 REMOTE-SITES-T5): the maintenance window of a fleet move.

import { describe, expect, it, vi } from "vitest";
import { FLEET_MOVE_WINDOW_REASON, fleetMoveMaintenance } from "./fleet-move-maintenance.js";
import type { BotMaintenancePort, MaintenanceWindowView } from "./reconciler.js";

function port(views: MaintenanceWindowView[], owned = true) {
  let i = 0;
  const fake: BotMaintenancePort = {
    enter: vi.fn(async () => ({ state: "entering" as const, runningRuns: 2, owned })),
    status: vi.fn(async () => views[Math.min(i++, views.length - 1)]!),
    exit: vi.fn(async () => undefined),
  };
  return fake;
}

describe("fleetMoveMaintenance", () => {
  it("returns only when the window is on and no run is in flight", async () => {
    const fake = port([
      { state: "entering", runningRuns: 2 },
      { state: "entering", runningRuns: 1 },
      { state: "on", runningRuns: 0 },
    ]);
    const sleep = vi.fn(async () => undefined);
    await fleetMoveMaintenance(fake, { sleep }).enter("bot-1");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fake.exit).not.toHaveBeenCalled();
  });

  it("keeps runs held: the reason is not a bot-profile window (those let chat wakes through)", () => {
    expect(FLEET_MOVE_WINDOW_REASON.startsWith("bot container ")).toBe(false);
  });

  it("does not start inside a window someone else opened", async () => {
    const fake = port([{ state: "on", runningRuns: 0 }], false);
    await expect(fleetMoveMaintenance(fake).enter("bot-1")).rejects.toThrow(/someone else/);
    expect(fake.exit).not.toHaveBeenCalled();
  });

  it("closes the window it opened when the drain does not finish", async () => {
    let clock = 0;
    const fake = port([{ state: "entering", runningRuns: 3 }]);
    const mm = fleetMoveMaintenance(fake, {
      drainTimeoutSec: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms * 100;
      },
    });
    await expect(mm.enter("bot-1")).rejects.toThrow(/still has 3 run/);
    expect(fake.exit).toHaveBeenCalledTimes(1);
  });

  it("exit tolerates a window that is already gone", async () => {
    const fake = port([{ state: "off", runningRuns: 0 }]);
    await fleetMoveMaintenance(fake).exit("bot-1");
    expect(fake.exit).not.toHaveBeenCalled();

    const open = port([{ state: "on", runningRuns: 0 }]);
    await fleetMoveMaintenance(open).exit("bot-1");
    expect(open.exit).toHaveBeenCalledTimes(1);
  });
});
