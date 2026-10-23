import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetSiteHealth } from "@myrmidon/db";
import { createSiteHealthMonitor, FAILOVER_RETRY_MS, type SiteHealthMonitorDeps } from "./site-health-monitor.js";
import type { SiteProbeOutcome } from "./site-health-probe.js";
import type { MonitoredSite } from "./site-health-store.js";
import { readFleetSiteMetrics, resetFleetSiteMetrics } from "./fleet-site-metrics.js";

const OK: SiteProbeOutcome = { result: "success", resourceDegraded: false };
const MISS: SiteProbeOutcome = { result: "timeout", resourceDegraded: false };
const T0 = 1_000_000;

/** A fake registry row and a fake clock; the monitor sees the site only through these ports. */
function world(initial: Partial<MonitoredSite> = {}) {
  const site: MonitoredSite = {
    id: "s1", companyId: "c1", name: "myr-vm1", url: "https://myr-vm1", status: "active", labels: {}, health: null, ...initial,
  };
  let clock = T0;
  let outcome: SiteProbeOutcome = OK;
  const events: string[] = [];
  const failover = vi.fn(async () => {
    events.push("failover");
    return { moved: [], unavailable: [], skipped: [], requeuedRuns: 0 };
  });
  const reconcileReturned = vi.fn(async () => {
    events.push("reconcile");
  });
  const deps: SiteHealthMonitorDeps = {
    listSites: async () => [{ ...site }],
    probe: async () => outcome,
    saveHealth: async (_id, health: FleetSiteHealth) => {
      site.health = health;
    },
    setStatus: async (_id, from, to) => {
      if (!from.includes(site.status)) return false;
      site.status = to;
      events.push(`status:${to}`);
      return true;
    },
    failover,
    reconcileReturned,
    now: () => clock,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const monitor = createSiteHealthMonitor(deps);
  return {
    site,
    events,
    failover,
    reconcileReturned,
    set: (o: SiteProbeOutcome) => {
      outcome = o;
    },
    /** Advances the clock to `ms` after the start and runs one 30 s tick. */
    async tickAt(ms: number) {
      clock = T0 + ms;
      return monitor.tick();
    },
  };
}

describe("site health monitor", () => {
  beforeEach(() => resetFleetSiteMetrics());

  it("a site that answers stays active and reachable, lastSeenAt is recorded", async () => {
    const w = world();
    const [r] = await w.tickAt(0);
    expect(r?.state).toBe("healthy");
    expect(w.site.status).toBe("active");
    expect(w.site.health?.snapshot.lastSeenAt).toBe(T0);
    expect(readFleetSiteMetrics().sites).toEqual([{ site: "myr-vm1", reachable: 1, lastSeenSeconds: 0 }]);
  });

  it("two misses change nothing; the third (90 s of misses) drains the site automatically and raises no failover", async () => {
    const w = world();
    await w.tickAt(0);
    w.set(MISS);
    await w.tickAt(30_000);
    await w.tickAt(60_000);
    expect(w.site.status).toBe("active");
    await w.tickAt(90_000);

    expect(w.site.status).toBe("draining");
    expect(w.site.health?.autoDrained).toBe(true);
    expect(w.site.health?.state).toBe("unreachable");
    expect(w.failover).not.toHaveBeenCalled();
    expect(readFleetSiteMetrics().sites[0]?.reachable).toBe(0);
  });

  it("fails the site over once after 10 minutes unavailable, then only on the paced retry", async () => {
    const w = world();
    w.set(MISS);
    await w.tickAt(0);
    for (let t = 30_000; t < 10 * 60_000; t += 30_000) await w.tickAt(t);
    expect(w.failover).not.toHaveBeenCalled();

    await w.tickAt(10 * 60_000);
    expect(w.failover).toHaveBeenCalledTimes(1);

    // The reducer's intent is one-shot: ticks right after do not call it again ...
    await w.tickAt(10 * 60_000 + 30_000);
    await w.tickAt(10 * 60_000 + 60_000);
    expect(w.failover).toHaveBeenCalledTimes(1);

    // ... a paced retry does, for bots that are still left.
    await w.tickAt(10 * 60_000 + FAILOVER_RETRY_MS);
    expect(w.failover).toHaveBeenCalledTimes(2);
  });

  it("an operator's drain is not the monitor's: no automatic failover, and it is never lifted", async () => {
    const w = world({ status: "draining", labels: { autoResume: "true" }, health: null });
    w.set(MISS);
    await w.tickAt(0);
    for (let t = 30_000; t <= 12 * 60_000; t += 30_000) await w.tickAt(t);
    expect(w.failover).not.toHaveBeenCalled();
    w.set(OK);
    for (let t = 12 * 60_000 + 30_000; t <= 14 * 60_000; t += 30_000) await w.tickAt(t);
    expect(w.site.status).toBe("draining");
    expect(w.site.health?.autoDrained).toBe(false);
  });

  it("a bad certificate quarantines the site and nothing else happens", async () => {
    const w = world();
    w.set({ result: "invalid_certificate", resourceDegraded: false });
    await w.tickAt(0);
    expect(w.site.status).toBe("quarantined");
    expect(w.failover).not.toHaveBeenCalled();
    expect(w.site.health?.state).toBe("quarantined");
  });

  it("a degraded answer shows degraded without draining", async () => {
    const w = world();
    w.set({ result: "success", resourceDegraded: true });
    const [r] = await w.tickAt(0);
    expect(r?.state).toBe("degraded");
    expect(w.site.status).toBe("active");
  });

  it("a returned site is reconciled after three answers, then stays draining without the autoResume label", async () => {
    const w = world();
    w.set(MISS);
    for (let t = 0; t <= 90_000; t += 30_000) await w.tickAt(t);
    w.set(OK);
    await w.tickAt(120_000);
    await w.tickAt(150_000);
    expect(w.reconcileReturned).not.toHaveBeenCalled();
    await w.tickAt(180_000);

    expect(w.reconcileReturned).toHaveBeenCalledTimes(1);
    expect(w.site.status).toBe("draining");
    await w.tickAt(210_000);
    expect(w.reconcileReturned).toHaveBeenCalledTimes(1);
  });

  it("with autoResume=true the drain is lifted only after the return pass ran", async () => {
    const w = world({ labels: { autoResume: "true" } });
    w.set(MISS);
    for (let t = 0; t <= 90_000; t += 30_000) await w.tickAt(t);
    w.set(OK);
    for (let t = 120_000; t <= 180_000; t += 30_000) await w.tickAt(t);

    const after = w.events.slice(w.events.indexOf("status:draining"));
    expect(after).toEqual(["status:draining", "reconcile", "status:active"]);
    expect(w.site.health?.autoDrained).toBe(false);
  });

  it("a failed return pass is retried on the next tick and the drain stays", async () => {
    const w = world({ labels: { autoResume: "true" } });
    w.reconcileReturned.mockRejectedValueOnce(new Error("quarantine failed"));
    w.set(MISS);
    for (let t = 0; t <= 90_000; t += 30_000) await w.tickAt(t);
    w.set(OK);
    for (let t = 120_000; t <= 180_000; t += 30_000) await w.tickAt(t);
    expect(w.site.status).toBe("draining");

    await w.tickAt(210_000);
    expect(w.reconcileReturned).toHaveBeenCalledTimes(2);
    expect(w.site.status).toBe("active");
  });

  it("a miss after the return resets the passes", async () => {
    const w = world();
    w.set(MISS);
    for (let t = 0; t <= 90_000; t += 30_000) await w.tickAt(t);
    w.set(OK);
    await w.tickAt(120_000);
    await w.tickAt(150_000);
    w.set(MISS);
    await w.tickAt(180_000);
    w.set(OK);
    await w.tickAt(210_000);
    await w.tickAt(240_000);
    expect(w.reconcileReturned).not.toHaveBeenCalled();
  });

  it("an error on one site does not stop the sweep and does not overlap with the next", async () => {
    const w = world();
    const probe = vi.fn().mockRejectedValueOnce(new Error("no client transport"));
    const monitor = createSiteHealthMonitor({
      listSites: async () => [w.site, { ...w.site, id: "s2", name: "second" }],
      probe: async (site) => {
        if (site.id === "s1") return probe();
        return OK;
      },
      saveHealth: async () => undefined,
      setStatus: async () => true,
      failover: w.failover,
      reconcileReturned: w.reconcileReturned,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const results = await monitor.tick();
    expect(results.map((r) => r.siteName)).toEqual(["second"]);
  });
});
