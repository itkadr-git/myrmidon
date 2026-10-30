// server/src/myrmidon/bot-containers/fleet-site-metrics.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): in-process counters and gauges of the remote sites, read by the
// board's /metrics endpoint (monitoring/metrics). Spec names (remote-sites-v2 7.1) are
// fleet.site.reachable{name}, fleet.site.last_seen_seconds{name}, fleet.exec.retries_total{site}
// and fleet.moves_total{result}; Prometheus text has no dots, so they render as
// myrmidon_fleet_site_reachable and so on.
//
// The health monitor sets a site's gauges on every probe; failover counts what it moved and the
// runs it requeued. State lives in this process only (like the other in-process families): a
// restart starts the counters from zero and the gauges from the next probe.

export type FleetMoveResult = "done" | "failed" | "unavailable";

export interface FleetSiteGaugeSample {
  site: string;
  reachable: 0 | 1;
  /** Seconds since the last successful probe, or null when the site has never answered. */
  lastSeenSeconds: number | null;
}

export interface FleetSiteMetricsSample {
  sites: FleetSiteGaugeSample[];
  retriesTotal: Array<{ site: string; count: number }>;
  movesTotal: Array<{ result: FleetMoveResult; count: number }>;
}

const MOVE_RESULTS: readonly FleetMoveResult[] = ["done", "failed", "unavailable"];

const gauges = new Map<string, { reachable: 0 | 1; lastSeenAtMs: number | null }>();
const retries = new Map<string, number>();
const moves = new Map<FleetMoveResult, number>();

export function recordFleetSiteHealth(site: string, reachable: boolean, lastSeenAtMs: number | null): void {
  gauges.set(site, { reachable: reachable ? 1 : 0, lastSeenAtMs });
}

/** The monitor stopped: a gauge nobody refreshes any more must not keep reporting. */
export function clearFleetSiteGauges(): void {
  gauges.clear();
}

/** A run of a lost site was requeued (fleet.exec.retries_total{site}). */
export function recordFleetExecRetry(site: string): void {
  retries.set(site, (retries.get(site) ?? 0) + 1);
}

/** The outcome of one failover move (fleet.moves_total{result}). */
export function recordFleetMove(result: FleetMoveResult): void {
  moves.set(result, (moves.get(result) ?? 0) + 1);
}

export function readFleetSiteMetrics(nowMs: number = Date.now()): FleetSiteMetricsSample {
  return {
    sites: [...gauges.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([site, g]) => ({
        site,
        reachable: g.reachable,
        lastSeenSeconds: g.lastSeenAtMs === null ? null : Math.max(0, Math.round((nowMs - g.lastSeenAtMs) / 1000)),
      })),
    retriesTotal: [...retries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([site, count]) => ({ site, count })),
    // Every result renders, zero included: "nothing failed over" must be distinguishable from "not wired".
    movesTotal: MOVE_RESULTS.map((result) => ({ result, count: moves.get(result) ?? 0 })),
  };
}

/** Test-only: the process never resets them. */
export function resetFleetSiteMetrics(): void {
  gauges.clear();
  retries.clear();
  moves.clear();
}
