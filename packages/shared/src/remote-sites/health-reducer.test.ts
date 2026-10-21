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
  it("drains exactly on the third consecutive poll miss", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");

    snapshot = tick(snapshot, 30_000);
    expect(snapshot).toMatchObject({ state: "healthy", missCount: 1, intents: [] });

    snapshot = tick(snapshot, 60_000);
    expect(snapshot).toMatchObject({ state: "healthy", missCount: 2, intents: [] });

    snapshot = tick(snapshot, 90_000);
    expect(snapshot).toMatchObject({ state: "unreachable", missCount: 3, intents: ["drain"] });

    snapshot = tick(snapshot, 120_000);
    expect(snapshot).toMatchObject({ state: "unreachable", missCount: 4, intents: [] });
  });

  it("resets misses and outage clock on recovery", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");
    snapshot = tick(snapshot, 30_000);
    snapshot = tick(snapshot, 60_000, "success");
    expect(snapshot).toMatchObject({ state: "healthy", missCount: 0, unavailableSince: null, lastSeenAt: 60_000 });
    snapshot = tick(snapshot, 90_000);
    expect(snapshot.intents).toEqual([]);
  });

  it("starts a fresh outage episode after recovery", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");
    snapshot = tick(snapshot, 30_000);
    snapshot = tick(snapshot, 60_000);
    snapshot = tick(snapshot, 90_000);
    expect(snapshot.state).toBe("unreachable");
    snapshot = tick(snapshot, 120_000, "success");
    expect(snapshot).toMatchObject({
      state: "healthy",
      missCount: 0,
      unavailableSince: null,
      failoverIssued: false,
    });

    snapshot = tick(snapshot, 150_000);
    snapshot = tick(snapshot, 180_000);
    const recovered = tick(snapshot, 210_000);
    expect(recovered).toMatchObject({ state: "unreachable", missCount: 3, unavailableSince: 150_000 });
    expect(recovered.intents).toEqual(["drain"]);
  });

  it("does not repeat failover in a later outage episode after one was issued", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");
    snapshot = tick(snapshot, 30_000);
    snapshot = tick(snapshot, 60_000);
    snapshot = tick(snapshot, 90_000);
    snapshot = tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS);
    expect(snapshot.intents).toEqual(["failover"]);

    snapshot = tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS + 30_000, "success");
    expect(snapshot.state).toBe("healthy");
    expect(snapshot.failoverIssued).toBe(false);
    snapshot = tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS + 60_000);
    snapshot = tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS + 90_000);
    snapshot = tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS + 120_000);
    expect(snapshot.intents).toEqual(["drain"]);
    const secondFailover = tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS + 60_000 + SITE_HEALTH_FAILOVER_AFTER_MS);
    expect(secondFailover.intents).toEqual(["failover"]);
  });

  it("emits failover at 10 minutes of uninterrupted unavailability from unavailableSince", () => {
    const atFailoverBoundary = (timestamp: number) => {
      let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");
      snapshot = tick(snapshot, 30_000);
      snapshot = tick(snapshot, 60_000);
      snapshot = tick(snapshot, 90_000);
      return tick(snapshot, timestamp);
    };
    expect(atFailoverBoundary(30_000 + SITE_HEALTH_FAILOVER_AFTER_MS - 1)).toMatchObject({
      unavailableSince: 30_000,
      failoverIssued: false,
      intents: [],
    });
    expect(atFailoverBoundary(30_000 + SITE_HEALTH_FAILOVER_AFTER_MS)).toMatchObject({
      unavailableSince: 30_000,
      failoverIssued: true,
      intents: ["failover"],
    });
    expect(atFailoverBoundary(30_000 + SITE_HEALTH_FAILOVER_AFTER_MS + 1).intents).toEqual(["failover"]);
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

  it("suppresses failover while quarantined or manually drained, including after success", () => {
    const heldSnapshot = (overrides: Partial<ReturnType<typeof createSiteHealthSnapshot>>) => createSiteHealthSnapshot({
      state: "unreachable",
      missCount: 3,
      unavailableSince: 0,
      ...overrides,
    });
    const cases = [
      heldSnapshot({ state: "quarantined" }),
      heldSnapshot({ state: "draining", manualDrain: true }),
    ];

    for (const held of cases) {
      const atThreshold = tick(held, SITE_HEALTH_FAILOVER_AFTER_MS);
      expect(atThreshold.intents).not.toContain("failover");
      expect(atThreshold.failoverIssued).toBe(false);

      const recovered = tick(atThreshold, SITE_HEALTH_FAILOVER_AFTER_MS + 1, "success");
      expect(recovered.state).toBe(held.state);
      expect(recovered.manualDrain).toBe(held.manualDrain);
      expect(recovered.failoverIssued).toBe(false);
      const timeoutAgain = tick(recovered, SITE_HEALTH_FAILOVER_AFTER_MS + 2);
      expect(timeoutAgain.intents).not.toContain("failover");
    }
  });

  it("never emits failover for a pinned outage after three misses, while unpinned outage does", () => {
    const outage = (pinnedBotCount: number) => {
      let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot({ pinnedBotCount }), 0, "success");
      snapshot = tick(snapshot, 30_000);
      snapshot = tick(snapshot, 60_000);
      snapshot = tick(snapshot, 90_000);
      return tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS);
    };
    expect(outage(1)).toMatchObject({ missCount: 4, failoverIssued: false });
    expect(outage(1).intents).not.toContain("failover");
    expect(outage(0)).toMatchObject({ failoverIssued: true, intents: ["failover"] });
  });

  it("preserves failover idempotency across a persisted snapshot round trip", () => {
    let snapshot: ReturnType<typeof reduceSiteHealth> = tick(createSiteHealthSnapshot(), 0, "success");
    snapshot = tick(snapshot, 30_000);
    snapshot = tick(snapshot, 60_000);
    snapshot = tick(snapshot, 90_000);
    snapshot = tick(snapshot, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS);
    const restored = JSON.parse(JSON.stringify({
      state: snapshot.state,
      lastSeenAt: snapshot.lastSeenAt,
      missCount: snapshot.missCount,
      unavailableSince: snapshot.unavailableSince,
      manualDrain: snapshot.manualDrain,
      pinnedBotCount: snapshot.pinnedBotCount,
      failoverIssued: snapshot.failoverIssued,
    })) as ReturnType<typeof createSiteHealthSnapshot>;
    expect(tick(restored, 30_000 + SITE_HEALTH_FAILOVER_AFTER_MS + 30_000).intents).not.toContain("failover");
  });

  it("exposes the documented polling and timeout budgets", () => {
    expect(SITE_HEALTH_POLL_INTERVAL_MS).toBe(30_000);
    expect(SITE_HEALTH_TIMEOUT_MS).toBe(5_000);
    expect(SITE_HEALTH_MISS_THRESHOLD).toBe(3);
  });
});
