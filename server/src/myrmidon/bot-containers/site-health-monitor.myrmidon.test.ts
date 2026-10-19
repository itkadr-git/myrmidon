import { describe, expect, it, vi } from "vitest";
import { createSiteHealthMonitor } from "./site-health-monitor.js";
import { createSiteHealthSnapshot } from "../../../../packages/shared/src/remote-sites/health-reducer.js";

describe("createSiteHealthMonitor", () => {
  it("fences before failover and persists the reducer snapshot", async () => {
    const calls: string[] = [];
    const save = vi.fn(async () => undefined);
    const monitor = createSiteHealthMonitor({
      listSites: async () => [{ name: "primary", status: "active" }],
      probe: async () => "timeout",
      load: async () => createSiteHealthSnapshot({ missCount: 2, unavailableSince: 0 }),
      save,
      fence: async () => { calls.push("fence"); },
      failover: async () => { calls.push("failover"); },
      now: () => 10 * 60_000,
    });
    const result = await monitor.tick();
    monitor.stop();
    expect(result[0]?.state).toBe("unreachable");
    expect(save).toHaveBeenCalledOnce();
    expect(calls).toEqual(["fence", "failover"]);
  });

  it("does not run overlapping sweeps", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const monitor = createSiteHealthMonitor({
      listSites: async () => { await pending; return []; },
      probe: async () => "success",
      load: async () => createSiteHealthSnapshot(),
      save: async () => undefined,
      fence: async () => undefined,
      failover: async () => undefined,
    });
    const first = monitor.tick();
    const second = await monitor.tick();
    expect(second).toEqual([]);
    release();
    await first;
    monitor.stop();
  });
});
