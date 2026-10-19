// myrmidon(1.6.6 REMOTE-SITES-T5): health polling and fencing orchestration.
// Network, persistence, and move execution stay behind injected ports.

import { reduceSiteHealth, SITE_HEALTH_POLL_INTERVAL_MS, type SiteHealthResult, type SiteHealthSnapshot } from "../../../../packages/shared/src/remote-sites/health-reducer.js";

export interface MonitoredSite {
  name: string;
  status: string;
  url: string;
}

export interface SiteHealthMonitorDeps {
  listSites(): Promise<MonitoredSite[]>;
  probe(site: MonitoredSite): Promise<SiteHealthResult>;
  load(siteName: string): Promise<SiteHealthSnapshot>;
  save(siteName: string, snapshot: SiteHealthSnapshot): Promise<void>;
  fence(siteName: string): Promise<void>;
  failover(siteName: string): Promise<void>;
  updateSiteStatus?(siteName: string, status: "unreachable" | "draining"): Promise<void>;
  now?: () => number;
  log?: { warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

export interface SiteHealthPollResult {
  siteName: string;
  state: SiteHealthSnapshot["state"];
  intents: string[];
}

export const SITE_HEALTH_MONITOR_INTERVAL_MS = SITE_HEALTH_POLL_INTERVAL_MS;

export function createSiteHealthMonitor(deps: SiteHealthMonitorDeps): {
  tick(): Promise<SiteHealthPollResult[]>;
  stop(): void;
} {
  let running = false;
  const now = deps.now ?? Date.now;

  async function tick(): Promise<SiteHealthPollResult[]> {
    if (running) return [];
    running = true;
    try {
      const results: SiteHealthPollResult[] = [];
      for (const site of await deps.listSites()) {
        let previous = await deps.load(site.name);
        try {
          const result = await deps.probe(site);
          const next = reduceSiteHealth({ previous, now: now(), result });
          if (result === "success" && previous.state === "unreachable") {
            // Recovery is observational only; an operator must re-enable the site.
            next.state = "unreachable";
          }
          await deps.save(site.name, next);

          // Fence before starting any move. The reducer emits each intent once
          // per outage episode, so retries cannot duplicate failover requests.
          if (next.intents.includes("drain")) {
            await deps.updateSiteStatus?.(site.name, "unreachable");
            await deps.fence(site.name);
          }
          if (next.intents.includes("failover")) {
            await deps.updateSiteStatus?.(site.name, "draining");
            await deps.failover(site.name);
          }
          results.push({ siteName: site.name, state: next.state, intents: next.intents });
        } catch (err) {
          deps.log?.error({ siteName: site.name, err }, "remote site health poll failed");
          results.push({ siteName: site.name, state: previous.state, intents: [] });
        }
      }
      return results;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch((err) => deps.log?.error({ err }, "remote site health sweep failed"));
  }, SITE_HEALTH_MONITOR_INTERVAL_MS);

  return { tick, stop: () => clearInterval(timer) };
}
