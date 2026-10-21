// myrmidon(PROCS-1.8): the settings applier registry maps keys to appliers and runs them in order.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const startRuntimeLimits = vi.hoisted(() => vi.fn());
const resetMaintenanceGateCaches = vi.hoisted(() => vi.fn());
const startProcessesSettings = vi.hoisted(() => vi.fn());

vi.mock("../runtime-limits/index.js", () => ({ startRuntimeLimits }));
vi.mock("../maintenance/gate.js", () => ({ resetMaintenanceGateCaches }));
vi.mock("../processes/index.js", () => ({ startProcessesSettings }));

import { applySettingsChanged, registerSettingsAppliers } from "./index.js";

const db = {} as Db;

function fakeBus() {
  const handlers: Array<(payload: unknown) => void> = [];
  return {
    subscribe<T>(_channel: "settings_changed", handler: (payload: T) => void) {
      handlers.push(handler as (payload: unknown) => void);
      return () => {
        handlers.splice(handlers.indexOf(handler as (payload: unknown) => void), 1);
      };
    },
    emit(payload: unknown) {
      for (const h of [...handlers]) h(payload);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settings appliers", () => {
  beforeEach(() => {
    startRuntimeLimits.mockReset().mockResolvedValue(undefined);
    resetMaintenanceGateCaches.mockReset();
    startProcessesSettings.mockReset().mockResolvedValue(undefined);
  });

  it("applies only the changed keys, from the database", async () => {
    const applyTeamLiveness = vi.fn().mockResolvedValue(undefined);
    await applySettingsChanged({ changedKeys: ["runLimits", "teamLiveness"] }, { db, applyTeamLiveness });
    expect(startRuntimeLimits).toHaveBeenCalledWith(db);
    expect(applyTeamLiveness).toHaveBeenCalledTimes(1);
    expect(resetMaintenanceGateCaches).not.toHaveBeenCalled();
    expect(startProcessesSettings).not.toHaveBeenCalled();
  });

  it("resets maintenance caches and re-applies the processes settings", async () => {
    const supervisor = {} as never;
    await applySettingsChanged(
      { changedKeys: ["myrmidonMaintenance", "processes"] },
      { db, processSupervisor: supervisor },
    );
    expect(resetMaintenanceGateCaches).toHaveBeenCalledTimes(1);
    expect(startProcessesSettings).toHaveBeenCalledWith(db, supervisor);
  });

  it("ignores unknown keys and empty payloads", async () => {
    await applySettingsChanged({ changedKeys: ["somethingElse"] }, { db });
    await applySettingsChanged({}, { db });
    expect(startRuntimeLimits).not.toHaveBeenCalled();
    expect(resetMaintenanceGateCaches).not.toHaveBeenCalled();
    expect(startProcessesSettings).not.toHaveBeenCalled();
  });

  it("two subscribers on one bus both apply a change published once (process A -> process B)", async () => {
    const bus = fakeBus();
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    registerSettingsAppliers(bus, { db, applyTeamLiveness: a });
    registerSettingsAppliers(bus, { db, applyTeamLiveness: b });
    bus.emit({ changedKeys: ["teamLiveness"] });
    await flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("runs applies one at a time in arrival order and survives an applier error", async () => {
    const bus = fakeBus();
    const order: string[] = [];
    let releaseFirst!: () => void;
    startRuntimeLimits
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = () => {
              order.push("first-done");
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async () => {
        order.push("second");
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => {
        order.push("third");
      });
    registerSettingsAppliers(bus, { db });
    bus.emit({ changedKeys: ["runLimits"] });
    bus.emit({ changedKeys: ["runLimits"] });
    bus.emit({ changedKeys: ["runLimits"] });
    await flush();
    expect(order).toEqual([]);
    releaseFirst();
    await flush();
    await flush();
    expect(order).toEqual(["first-done", "second", "third"]);
  });

  it("stops applying after unsubscribe", async () => {
    const bus = fakeBus();
    const off = registerSettingsAppliers(bus, { db });
    off();
    bus.emit({ changedKeys: ["runLimits"] });
    await flush();
    expect(startRuntimeLimits).not.toHaveBeenCalled();
  });
});
