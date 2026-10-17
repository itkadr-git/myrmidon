import { describe, expect, it } from "vitest";
import {
  createSiteHealthSnapshot,
  reduceSiteHealth,
  SITE_HEALTH_FAILOVER_AFTER_MS,
  SITE_HEALTH_MISS_THRESHOLD,
  SITE_HEALTH_POLL_INTERVAL_MS,
  SITE_HEALTH_TIMEOUT_MS,
} from "./health-reducer.js";

const tick = (previous: ReturnType<typeof createSiteHealthSnapshot> | ReturnType<typeof reduceSiteHealth>, now: number, result: "success" | "timeout" | "invalid_certificate" | "incompatible_protocol" = "timeout", resourceDegraded = false) => {
  const snapshot = "intents" in previous ? { ...previous } : previous;
  delete (snapshot as Partial<ReturnType<typeof reduceSiteHealth>>).intents;
  return reduceSiteHealth({ previous: snapshot, now, result, resourceDegraded });
};

describe("reduceSiteHealth", () => {
  it("drains on the third consecutive miss, not before", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot({ lastSeenAt: 0 }), 0, "success");
    snapshot = tick(snapshot, 30_000);
    expect(snapshot.state).toBe("unknown");
    snapshot = tick(snapshot, 60_000);
    expect(snapshot.intents).toEqual([]);
    snapshot = tick(snapshot, 90_000);
    expect(snapshot.state).toBe("unreachable");
    expect(snapshot.intents).toEqual(["drain"]);
    expect(tick(snapshot, 120_000).intents).toEqual([]);
  });

  it("resets misses and outage clock on recovery", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");
    snapshot = tick(snapshot, 30_000);
    snapshot = tick(snapshot, 60_000, "success");
    expect(snapshot).toMatchObject({ state: "healthy", missCount: 0, unavailableSince: null, lastSeenAt: 60_000 });
    snapshot = tick(snapshot, 90_000);
    expect(snapshot.intents).toEqual([]);
  });

  it("emits failover only at ten uninterrupted minutes and only once outage qualifies", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");
    snapshot = tick(snapshot, 30_000);
    snapshot = tick(snapshot, 60_000);
    snapshot = tick(snapshot, 90_000);
    expect(snapshot.intents).toEqual(["drain"]);
    snapshot = tick(snapshot, SITE_HEALTH_FAILOVER_AFTER_MS - 1);
    expect(snapshot.intents).toEqual([]);
    snapshot = tick(snapshot, SITE_HEALTH_FAILOVER_AFTER_MS + 30_000);
    expect(snapshot.intents).toEqual(["failover"]);
    snapshot = tick(snapshot, SITE_HEALTH_FAILOVER_AFTER_MS + 60_000);
    expect(snapshot.intents).toEqual([]);
  });

  it("quarantines invalid trust/protocol and recovery never clears quarantine", () => {
    for (const result of ["invalid_certificate", "incompatible_protocol"] as const) {
      const quarantined = tick(createSiteHealthSnapshot(), 1, result);
      expect(quarantined.state).toBe("quarantined");
      expect(quarantined.intents).toEqual(["quarantine"]);
      expect(tick(quarantined, 2, "success").state).toBe("quarantined");
    }
  });

  it("keeps manual drain and quarantine across success; degradation does not drain", () => {
    const draining = createSiteHealthSnapshot({ state: "draining", manualDrain: true });
    expect(tick(draining, 10, "success").state).toBe("draining");
    const quarantined = createSiteHealthSnapshot({ state: "quarantined" });
    expect(tick(quarantined, 10, "success").state).toBe("quarantined");
    const degraded = tick(createSiteHealthSnapshot(), 10, "success", true);
    expect(degraded.state).toBe("degraded");
    expect(degraded.intents).toEqual([]);
  });

  it("does not propose failover for pinned bots", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot({ pinnedBotCount: 1 }), 0, "success");
    snapshot = tick(snapshot, 0);
    snapshot = tick(snapshot, SITE_HEALTH_FAILOVER_AFTER_MS);
    expect(snapshot.intents).not.toContain("failover");
  });

  it("exposes the documented polling and timeout budgets", () => {
    expect(SITE_HEALTH_POLL_INTERVAL_MS).toBe(30_000);
    expect(SITE_HEALTH_TIMEOUT_MS).toBe(5_000);
    expect(SITE_HEALTH_MISS_THRESHOLD).toBe(3);
  });
});
